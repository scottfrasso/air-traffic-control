// Runs inside the checker container (Node 24 strips the types natively; erasable syntax only).
// Input: JSON in the CHECK_INPUT env var. Output: one JSON line on stdout, prefixed with "@@RESULT ".
//
// Modes (worker/src/review):
//   snapshot  the repo at a PR's head as tar.gz, its diff, changed paths, and its .atc/* + REVIEW.md config
//   ci        run the repo's CI commands at a commit, each a check, bounded per command
//   diff      the PR's whole change for the web UI
//   merge     merge a PR branch onto its target, run CI on the result, push the target only if CI passes
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface RepoRef { name: string; remote: string; token: string }

type Input =
  | { mode: "snapshot"; repo: RepoRef; branch: string; target: string; sha: string; base: string | null; since?: string | null }
  | { mode: "diff"; repo: RepoRef; branch: string; target: string; sha: string; base: string | null }
  | { mode: "ci"; repo: RepoRef; branch: string; sha: string; commands: CiCommand[] }
  | { mode: "merge"; repo: RepoRef; source: string; target: string; expectedSource: string; expectedTarget: string; message: string; commands: CiCommand[] };

interface CiCommand { name: string; run: string; timeoutSeconds: number }
interface CiCheck { name: string; status: "passed" | "failed" | "errored" | "skipped"; log: string; ms: number }

const startedAt = Date.now(); // before the startup git lock, so "total" includes every wait (review of #36)
/**
 * Progress on stderr, so a run killed by the hard timeout still says where it was: the Checker DO puts the end of
 * stderr in its error (the hang hunt of 2026-10-15). stdout carries only the result line.
 */
const progress = (msg: string) => { try { process.stderr.write(`@@ ${Date.now() - startedAt}ms ${msg}\n`); } catch { /* closed */ } };
const input = JSON.parse(process.env.CHECK_INPUT ?? "{}") as Input;
// Persistent cache (lives as long as the warm container): one repo whose object store accumulates every branch
// fetched, so each run fetches only deltas.
// ATC_CACHE / ATC_WORK exist for the local tests (worker/test/review-container.test.ts); the container uses the defaults.
const CACHE = process.env.ATC_CACHE ?? "/cache";
const WORK = process.env.ATC_WORK ?? "/work";
const repoDir = join(CACHE, "repo");
mkdirSync(CACHE, { recursive: true });
mkdirSync(WORK, { recursive: true });

// ── one git writer at a time (issue #8) ──
// Concurrent checks are separate processes sharing /cache/repo. Git fails (it doesn't wait) on index.lock and ref
// locks, so every command that writes refs or worktree metadata, and each fetch + rev-parse pair, holds a lock
// directory (mkdir is atomic). Typechecks and merges in their own worktrees stay parallel.
const LOCK = join(CACHE, "git.lock");
const LOCK_STALE_MS = 300_000; // longer than the checker's hard timeout (240 s), so only a lost lock is ever broken
const BREAK_STALE_MS = 10_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** A zombie counts as dead: the container's PID 1 (`sleep infinity`) never reaps orphans (review of #34). */
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch (e) { return (e as { code?: string }).code === "EPERM"; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"; } catch { return true; } // no /proc (macOS): trust kill()
};
const lockOwner = (lock: string): { pid: number; age: number } | null => {
  let age = 0;
  try { age = Date.now() - statSync(lock).mtimeMs; } catch { return null; } // no lock
  let pid = 0;
  try { pid = Number(readFileSync(join(lock, "pid"), "utf8")); } catch { /* an empty dir (older code): only age can break it */ }
  return { pid, age };
};
/** Move a directory out of the way, then delete it: the rename is atomic, so a lock is never half-removed. */
const discard = (path: string) => {
  const gone = `${path}.gone.${process.pid}.${Date.now()}`;
  try { renameSync(path, gone); } catch { return false; }
  rmSync(gone, { recursive: true, force: true });
  return true;
};

/**
 * Break a lock whose owner died (the hard timeout kills the whole process group) or that is far too old. Only one
 * process breaks at a time (the .break guard), and it re-reads the owner first, so it can't remove a live lock that
 * another breaker just replaced (review of #34).
 */
function breakIfStale(lock: string, seen: { pid: number; age: number }) {
  // An unreadable pid means the lock is changing hands (stat and read raced a release), not that it's ownerless: a lock
  // always has its pid file, and an empty dir is simply replaced by the rename. Only a dead owner or age breaks it.
  if (!seen.pid || !(!alive(seen.pid) || seen.age > LOCK_STALE_MS)) return;
  const guard = `${lock}.break`;
  try { mkdirSync(guard); } catch {
    try { if (Date.now() - statSync(guard).mtimeMs > BREAK_STALE_MS) discard(guard); } catch { /* gone already */ }
    return;
  }
  try {
    const now = lockOwner(lock);
    if (now && now.pid === seen.pid) discard(lock); // still the same dead (or ancient) owner
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

const held = new Map<string, number>(); // lock path → depth held by this process
/**
 * A cross-process lock at `lock`: built under a private name with its pid file, then renamed into place, so it never
 * exists without an owner, and renaming onto a held (non-empty) lock fails atomically. Re-entrant per path.
 */
function withLock<T>(lock: string, fn: () => T): T {
  const depth = held.get(lock) ?? 0;
  if (depth > 0) { held.set(lock, depth + 1); try { return fn(); } finally { held.set(lock, depth); } }
  const mine = `${lock}.${process.pid}`;
  const waitStart = Date.now();
  let reported = 0;
  for (;;) {
    rmSync(mine, { recursive: true, force: true });
    mkdirSync(mine);
    writeFileSync(join(mine, "pid"), String(process.pid));
    try {
      renameSync(mine, lock);
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EPERM") { rmSync(mine, { recursive: true, force: true }); throw e; }
      rmSync(mine, { recursive: true, force: true }); // don't leave it behind if the hard timeout kills us while waiting
      const owner = lockOwner(lock);
      if (owner) breakIfStale(lock, owner);
      // Waiting long for a lock is the first suspect in a hung run: say who holds it (then every 30 s).
      const waited = Date.now() - waitStart;
      if (waited > 2_000 && waited - reported >= (reported ? 30_000 : 0)) {
        reported = waited;
        progress(`waiting ${Math.round(waited / 1000)}s for ${lock.replace(CACHE, "")} held by pid ${owner?.pid ?? "?"} (${owner ? `${Math.round(owner.age / 1000)}s old, ${alive(owner.pid) ? "alive" : "dead"}` : "gone"})`);
      }
      sleep(20);
    }
  }
  held.set(lock, 1);
  try {
    return fn();
  } finally {
    held.delete(lock);
    if (lockOwner(lock)?.pid === process.pid) discard(lock); // only ever release our own lock
  }
}
const withGitLock = <T,>(fn: () => T): T => withLock(LOCK, fn);
const gitLockHeld = () => (held.get(LOCK) ?? 0) > 0;
const WRITES = new Set(["init", "fetch", "update-ref", "worktree", "notes", "gc", "prune"]);


withGitLock(() => {
  if (!existsSync(join(repoDir, ".git"))) {
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
  }
});
let dir = repoDir; // git commands run here; typechecks run in throwaway worktrees
const timings: Array<{ step: string; ms: number; cached?: boolean }> = [];
const timed = <T,>(step: string, fn: () => T): T => { progress(`step ${step}`); const t = Date.now(); const r = fn(); timings.push({ step, ms: Date.now() - t }); return r; };

function git(args: string[], opts: { token?: string; allowFail?: boolean; input?: string; timeoutMs?: number } = {}): { ok: boolean; out: string } {
  // The subcommand: the first argument that isn't an option. Every `-c` value here contains "=", so it's skipped;
  // a bare `-C <path>` would be misread (not used).
  const sub = args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "";
  if (dir === repoDir && WRITES.has(sub) && !gitLockHeld()) return withGitLock(() => git(args, opts));
  // No automatic gc: it would rewrite the shared repo while another check reads it.
  const auth = ["-c", "gc.auto=0"];
  // The token goes through git's environment, never its argv: /proc/<pid>/cmdline is readable by every user in the
  // container, /proc/<pid>/environ only by this one (CI commands run as another user; review of PR #50).
  const env = opts.token ? { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${opts.token}` } : process.env;
  try {
    return {
      ok: true,
      out: execFileSync("git", [...auth, ...args], { cwd: dir, env, encoding: "utf8", stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input: opts.input, timeout: opts.timeoutMs }).trim(),
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (!opts.allowFail) throw new Error(`git ${args[0]} failed: ${out}`);
    return { ok: false, out };
  }
}

/** Fetch a branch of a repo (review pipeline: PRs are branches); returns the fetched sha. */
function fetchBranch(repo: RepoRef, branch: string): string {
  const ref = `refs/atc-branches/${repo.name}/${branch}`;
  return withGitLock(() => {
    timed(`fetch ${branch}`, () => git([...LOW_SPEED, "fetch", "-q", "--no-tags", repo.remote, `+refs/heads/${branch}:${ref}`], { token: repo.token, timeoutMs: FETCH_TIMEOUT_MS }));
    return git(["rev-parse", ref]).out;
  });
}

/** The text of `path` at `sha`, or null if it isn't there. */
const fileAt = (sha: string, path: string): string | null => {
  const r = git(["show", `${sha}:${path}`], { allowFail: true });
  return r.ok ? `${r.out}\n` : null;
};

const SNAPSHOT_MAX_BYTES = 25 * 1024 * 1024;

const diffOf = (range: string[]) => {
  const d = timed("diff", () => git(["diff", "--no-color", "--no-ext-diff", ...range]).out);
  return { diff: d ? `${d}\n` : "", paths: git(["diff", "--name-only", ...range]).out.split("\n").filter(Boolean) };
};

/**
 * The PR's whole change (three-dot against `base`, like a code host): risk and the hard rules are always judged on
 * all of it, never on a follow-up's delta (review of PR #50). With `since`, also the delta since the last reviewed
 * commit, which follow-up reviewers focus on.
 */
function changes(i: { repo: RepoRef; branch: string; target: string; sha: string; base: string | null; since?: string | null }) {
  const targetHead = fetchBranch(i.repo, i.target);
  fetchBranch(i.repo, i.branch);
  if (!git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok) throw new Error(`commit ${i.sha.slice(0, 7)} isn't on ${i.branch}`);
  const whole = diffOf(i.base ? [`${i.base}...${i.sha}`] : [`${i.sha}^`, i.sha]);
  const delta = i.since && git(["cat-file", "-e", `${i.since}^{commit}`], { allowFail: true }).ok ? diffOf([i.since, i.sha]) : null;
  return { targetHead, diff: whole.diff, changedPaths: whole.paths, ...(delta ? { sinceDiff: delta.diff, sinceChangedPaths: delta.paths } : {}) };
}

function snapshot(i: Extract<Input, { mode: "snapshot" }>) {
  const { targetHead, ...change } = changes(i);
  const tarGz = timed("archive", () => execFileSync("git", ["archive", "--format=tar.gz", i.sha], { cwd: dir, maxBuffer: SNAPSHOT_MAX_BYTES * 2 }));
  if (tarGz.byteLength > SNAPSHOT_MAX_BYTES) throw new Error(`repository archive is ${Math.round(tarGz.byteLength / 1e6)} MB, over the ${SNAPSHOT_MAX_BYTES / 1e6} MB limit`);
  return {
    mode: "snapshot", sha: i.sha, ...change, tarGzBase64: tarGz.toString("base64"),
    // CI is the PR's own (it may change its tests). Review guidance, budgets and owners come from the target: a PR
    // must not rewrite the rules it is reviewed by (review of PR #50).
    config: { ci: fileAt(i.sha, ".atc/ci.yml"), review: fileAt(targetHead, ".atc/review.yml"), owners: fileAt(targetHead, ".atc/owners"), reviewMd: fileAt(targetHead, "REVIEW.md") },
    timings,
  };
}

/** The unprivileged user CI commands run as when the container runs as root (Dockerfile: useradd ci). */
const CI_UID = 10001;
const asCi = typeof process.getuid === "function" && process.getuid() === 0 ? { uid: CI_UID, gid: CI_UID } : {};

/**
 * One CI command in its own process group, as the ci user when we're root, with a minimal environment (no tokens, no
 * CHECK_INPUT). When it exits or times out, its whole group is killed, so nothing it started in the background
 * outlives it to tamper with the shared repo or later runs (review of PR #50).
 */
function runCommand(c: CiCommand, cwd: string, home: string): Promise<{ status: number | null; timedOut: boolean; out: string; error?: Error }> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const killGroup = (pid: number | undefined) => { if (pid) try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } };
    const child = spawn("sh", ["-c", `exec 2>&1\n${c.run}`], {
      cwd, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, CI: "true" }, detached: true, stdio: ["ignore", "pipe", "pipe"], ...asCi,
    });
    child.stdout.on("data", (d: Buffer) => { out = (out + d.toString("utf8")).slice(-200_000); });
    child.stderr.on("data", (d: Buffer) => { out = (out + d.toString("utf8")).slice(-200_000); });
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, c.timeoutSeconds * 1000);
    child.on("error", (error) => { clearTimeout(timer); resolve({ status: null, timedOut, out, error }); });
    // "exit", not "close": a background child holding the pipe open must not keep us waiting.
    child.on("exit", (status) => {
      clearTimeout(timer);
      killGroup(child.pid);
      setTimeout(() => resolve({ status, timedOut, out }), 50); // let the last output arrive
    });
  });
}

/** Run CI commands in a fresh worktree at `sha`, in order; the first failure stops the rest (shown as skipped). */
async function runCi(sha: string, commands: CiCommand[]): Promise<CiCheck[]> {
  const wt = mkdtempSync(join(WORK, "ci-"));
  const home = mkdtempSync(join(WORK, "ci-home-"));
  const out: CiCheck[] = [];
  try {
    git(["worktree", "add", "-q", "--detach", wt, sha]);
    if ("uid" in asCi) execFileSync("chown", ["-R", `${CI_UID}:${CI_UID}`, wt, home]);
    let stopped = false;
    for (const c of commands) {
      if (stopped) {
        out.push({ name: c.name, status: "skipped", log: "not run: an earlier command failed", ms: 0 });
        continue;
      }
      progress(`ci ${c.name}`);
      const t = Date.now();
      const r = await runCommand(c, wt, home);
      const ms = Date.now() - t;
      const tail = r.out.slice(-7800);
      if (r.timedOut) out.push({ name: c.name, status: "errored", log: `${tail}\n[timed out after ${c.timeoutSeconds} s]`, ms });
      else if (r.error) out.push({ name: c.name, status: "errored", log: `could not run: ${r.error.message}`, ms });
      else out.push({ name: c.name, status: r.status === 0 ? "passed" : "failed", log: r.status === 0 ? tail : `${tail}\n[exit ${r.status}]`, ms });
      stopped = out.at(-1)!.status !== "passed";
    }
  } finally {
    git(["worktree", "remove", "--force", wt], { allowFail: true });
    rmSync(home, { recursive: true, force: true });
  }
  return out;
}

async function ci(i: Extract<Input, { mode: "ci" }>) {
  fetchBranch(i.repo, i.branch);
  if (!git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok) throw new Error(`commit ${i.sha.slice(0, 7)} isn't on ${i.branch}`);
  return { mode: "ci", checks: await runCi(i.sha, i.commands), timings };
}

/** Merge queue for a PR: source onto the target's current head, CI on that exact commit, then a fast-forward push. */
async function merge(i: Extract<Input, { mode: "merge" }>) {
  const target = fetchBranch(i.repo, i.target);
  const source = fetchBranch(i.repo, i.source);
  if (source !== i.expectedSource) return { mode: "merge", merged: false, retry: true, reason: `${i.source} moved to ${source.slice(0, 7)} since it was reviewed (${i.expectedSource.slice(0, 7)})` };
  if (target !== i.expectedTarget) return { mode: "merge", merged: false, retry: true, reason: `${i.target} moved to ${target.slice(0, 7)}; merge again onto the new head`, targetHead: target };
  const onto = ontoBase(source, target, i.message);
  if ("conflicts" in onto) return { mode: "merge", merged: false, reason: `merge conflict with ${i.target} in ${onto.conflicts.join(", ")}`, conflicts: onto.conflicts };
  const checks = await runCi(onto.sha, i.commands);
  if (checks.some((c) => c.status !== "passed" && c.status !== "skipped")) return { mode: "merge", merged: false, reason: "CI failed on the merged commit", checks, sha: onto.sha };
  const push = timed("push target", () => git([...LOW_SPEED, "push", "-q", i.repo.remote, `${onto.sha}:refs/heads/${i.target}`], { token: i.repo.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS }));
  if (!push.ok) return { mode: "merge", merged: false, retry: true, reason: `push to ${i.target} failed (${push.out.slice(0, 160)}); retry`, checks };
  return { mode: "merge", merged: true, sha: onto.sha, checks, timings };
}

/**
 * Merge-queue step: put `fork` on top of `base`. If the fork already contains base, that's the fork itself;
 * otherwise create a merge commit in a scratch worktree (first parent = base, so pushing it to main is a fast-forward).
 */
function ontoBase(fork: string, base: string, message: string): { sha: string } | { conflicts: string[]; output: string } {
  if (git(["merge-base", "--is-ancestor", base, fork], { allowFail: true }).ok) return { sha: fork };
  const wt = mkdtempSync(join(WORK, "onto-"));
  const prev = dir;
  try {
    git(["worktree", "add", "-q", "--detach", wt, base]);
    dir = wt;
    const merge = git(["merge", "--no-ff", "-q", "-m", message, fork], { allowFail: true });
    if (!merge.ok) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split("\n").filter(Boolean);
      return { conflicts, output: merge.out.slice(0, 2000) };
    }
    const sha = git(["rev-parse", "HEAD"]).out;
    dir = repoDir;
    git(["update-ref", `refs/agentmesh/onto-${sha.slice(0, 12)}`, sha]); // keep the object reachable for push
    return { sha };
  } finally {
    dir = prev;
    git(["worktree", "remove", "--force", wt], { allowFail: true });
  }
}

/** Fail a stalled transfer after 10 s below 1 KB/s, instead of hanging until the checker's hard timeout. */
const LOW_SPEED = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=10"];
const PUSH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;

async function run(): Promise<unknown> {
  if (input.mode === "snapshot") return snapshot(input);
  if (input.mode === "diff") {
    const { diff, changedPaths } = changes(input);
    return { mode: "diff", diff, changedPaths, timings };
  }
  if (input.mode === "ci") return ci(input);
  return merge(input);
}

try {
  const result = (await run()) as { timings?: unknown[] };
  // Wall time of the whole check, including waits for locks and cached results (steps alone miss those; review of #36).
  if (Array.isArray(result.timings)) result.timings.push({ step: "total", ms: Date.now() - startedAt });
  console.log(`@@RESULT ${JSON.stringify(result)}`);
} catch (err) {
  console.log(`@@RESULT ${JSON.stringify({ error: (err as Error).message })}`);
} finally {
  git(["worktree", "prune"], { allowFail: true });
}

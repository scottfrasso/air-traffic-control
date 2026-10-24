// Runs inside the checker container (Node 24 strips the types natively; erasable syntax only).
// Input: JSON in the CHECK_INPUT env var. Output: one JSON line on stdout, prefixed with "@@RESULT ".
//
// Modes (worker/src/review):
//   snapshot  the repo at a PR's head as tar.gz, its diff, changed paths, and its .atc/* + REVIEW.md config
//   ci        run the repo's CI commands at a commit, each a check, bounded per command
//   diff      the PR's whole change for the web UI
//   merge     merge a PR branch onto its target, run CI on the result, push the target only if CI passes
//   restore   put a protected branch back to a commit (a push that didn't come from a merge)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface RepoRef { name: string; remote: string; token: string }

type Input =
  | { mode: "snapshot"; repo: RepoRef; branch: string; target: string; sha: string; base: string | null; since?: string | null }
  | { mode: "diff"; repo: RepoRef; branch: string; target: string; sha: string; base: string | null }
  | { mode: "ci"; repo: RepoRef; branch: string; sha: string; commands: CiCommand[] }
  | { mode: "merge"; repo: RepoRef; source: string; target: string; expectedSource: string; expectedTarget: string; message: string; commands: CiCommand[]; keepRef?: string }
  | { mode: "restore"; repo: RepoRef; branch: string; sha: string; current: string; keepRef?: string }
  | { mode: "keep"; repo: RepoRef; branch: string; sha: string; keepRef: string };

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

/** The most git output we read: a diff this size is past the store's 2 MB cap anyway. */
const GIT_MAX_OUTPUT = 64 * 1024 * 1024;

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
      // maxBuffer: Node's 1 MB default made any diff over 1 MB fail (security review, 10-23).
      out: execFileSync("git", [...auth, ...args], { cwd: dir, env, encoding: "utf8", stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input: opts.input, timeout: opts.timeoutMs, maxBuffer: GIT_MAX_OUTPUT }).trim(),
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
  // --no-renames: a rename lists both paths, so moving a protected file out of an owners glob still needs a person.
  const d = timed("diff", () => git(["diff", "--no-color", "--no-ext-diff", "--no-renames", ...range]).out);
  // -z: real names, NUL-separated. Without it git quotes non-ASCII paths ("a/\303\251.ts"), which no owners glob
  // matches (security review, 10-23).
  return { diff: d ? `${d}\n` : "", paths: git(["diff", "--name-only", "-z", "--no-renames", ...range]).out.split("\0").filter(Boolean) };
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
  // Against the target's head, three-dot (from their merge base): once the branch merges the target in, the target's
  // own changes drop out of the PR, as on any code host. The stored base is only a hint (review of 10-17).
  const whole = diffOf([`${targetHead}...${i.sha}`]);
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
    // Budgets and minApprovals come from main whatever the target: the author picks the target, so a branch of their
    // own with big budgets must not set what a run may spend (security review, 10-17).
    config: { ci: fileAt(i.sha, ".atc/ci.yml"), review: fileAt(i.target === DEFAULT_BRANCH ? targetHead : fetchBranch(i.repo, DEFAULT_BRANCH), ".atc/review.yml"), owners: fileAt(targetHead, ".atc/owners"), reviewMd: fileAt(targetHead, "REVIEW.md") },
    timings,
  };
}

/** The repo's main branch: where budgets and minApprovals live. */
const DEFAULT_BRANCH = "main";

/**
 * When the container runs as root, each CI job runs as its own throwaway uid, so one job's leftovers can't touch
 * another PR's worktree, and everything that uid still runs afterwards is killed, even what left the process group
 * with setsid (security review, 10-17). Not root (tests): run as ourselves.
 */
const ROOT = typeof process.getuid === "function" && process.getuid() === 0;
// From our pid, not a random number: two concurrent jobs are two processes, so they never share a uid (and pkill -U never
// kills the other job; security review, 10-23).
const jobUser = () => (ROOT ? { uid: 20000 + (process.pid % 40000), gid: 10001 } : null);
/**
 * Per job: files up to 4 GB (ulimit -f counts 1 KiB blocks), and for a job's own uid at most 512 processes (the
 * process limit counts every process of the uid, so it only makes sense for a uid of its own).
 */
const limits = (user: { uid: number } | null) => `ulimit -f 4194304 2>/dev/null;${user ? " ulimit -u 512 2>/dev/null;" : ""}`;

/**
 * One CI command in its own process group, as the ci user when we're root, with a minimal environment (no tokens, no
 * CHECK_INPUT). When it exits or times out, its whole group is killed, so nothing it started in the background
 * outlives it to tamper with the shared repo or later runs (review of PR #50).
 */
function runCommand(c: CiCommand, cwd: string, home: string, user: { uid: number; gid: number } | null): Promise<{ status: number | null; timedOut: boolean; out: string; error?: Error }> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const killGroup = (pid: number | undefined) => { if (pid) try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } };
    const child = spawn("sh", ["-c", `exec 2>&1\n${limits(user)}\n${c.run}`], {
      // (The cast: wrangler's generated types add the Worker's vars to ProcessEnv; this process has only these.)
      cwd, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: join(home, "tmp"), CI: "true" } as unknown as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"], ...(user ?? {}),
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
  const user = jobUser();
  try {
    git(["worktree", "add", "-q", "--detach", wt, sha]);
    mkdirSync(join(home, "tmp")); // the job's own temp directory, not the container's shared /tmp
    if (user) execFileSync("chown", ["-R", `${user.uid}:${user.gid}`, wt, home]);
    let stopped = false;
    for (const c of commands) {
      if (stopped) {
        out.push({ name: c.name, status: "skipped", log: "not run: an earlier command failed", ms: 0 });
        continue;
      }
      progress(`ci ${c.name}`);
      const t = Date.now();
      const r = await runCommand(c, wt, home, user);
      const ms = Date.now() - t;
      const tail = r.out.slice(-7800);
      if (r.timedOut) out.push({ name: c.name, status: "errored", log: `${tail}\n[timed out after ${c.timeoutSeconds} s]`, ms });
      else if (r.error) out.push({ name: c.name, status: "errored", log: `could not run: ${r.error.message}`, ms });
      else out.push({ name: c.name, status: r.status === 0 ? "passed" : "failed", log: r.status === 0 ? tail : `${tail}\n[exit ${r.status}]`, ms });
      stopped = out.at(-1)!.status !== "passed";
    }
  } finally {
    // Whatever the job's uid still runs (a daemon started with setsid escapes the group kill) dies with the job.
    if (user) spawnSync("pkill", ["-KILL", "-U", String(user.uid)], { stdio: "ignore" }); // exit 1 = nothing left: fine
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
  // `retry` means one thing: the target moved, so merging again onto `targetHead` may work (code review, 10-17).
  if (source !== i.expectedSource) return { mode: "merge", merged: false, reason: `${i.source} moved to ${source.slice(0, 7)} since it was reviewed (${i.expectedSource.slice(0, 7)})` };
  if (target !== i.expectedTarget) return { mode: "merge", merged: false, retry: true, reason: `${i.target} moved to ${target.slice(0, 7)}; merge again onto the new head`, targetHead: target };
  const onto = ontoTarget(source, target, i.message);
  if ("conflicts" in onto) return { mode: "merge", merged: false, reason: `merge conflict with ${i.target} in ${onto.conflicts.join(", ")}`, conflicts: onto.conflicts };
  try {
    const checks = await runCi(onto.sha, i.commands);
    if (checks.some((c) => c.status !== "passed" && c.status !== "skipped")) return { mode: "merge", merged: false, reason: "CI failed on the merged commit", checks, sha: onto.sha };
    const push = timed("push target", () => git([...LOW_SPEED, "push", "-q", i.repo.remote, `${onto.sha}:refs/heads/${i.target}`], { token: i.repo.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS }));
    if (!push.ok) return { mode: "merge", merged: false, reason: `push to ${i.target} failed (${push.out.slice(0, 160)}); merge again`, checks };
    // Keep the merged commit under a hidden ref too, so a restore can fetch it after any force push (security review,
    // 10-23). Best effort: the store also knows the sha, and the warm cache usually has it.
    if (i.keepRef) git([...LOW_SPEED, "push", "-q", "--force", i.repo.remote, `${onto.sha}:${i.keepRef}`], { token: i.repo.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS });
    return { mode: "merge", merged: true, sha: onto.sha, checks, timings };
  } finally {
    if (onto.sha !== source) git(["update-ref", "-d", ontoRef(onto.sha)], { allowFail: true }); // pushed or not, the scratch ref goes
  }
}

/**
 * Put the PR's head on top of the target's head. If the head already contains the target, that's the head itself;
 * otherwise create a merge commit in a scratch worktree (first parent = target, so pushing it is a fast-forward).
 */
const ontoRef = (sha: string) => `refs/agentmesh/onto-${sha.slice(0, 12)}`;

function ontoTarget(head: string, target: string, message: string): { sha: string } | { conflicts: string[]; output: string } {
  if (git(["merge-base", "--is-ancestor", target, head], { allowFail: true }).ok) return { sha: head };
  const wt = mkdtempSync(join(WORK, "onto-"));
  const prev = dir;
  try {
    git(["worktree", "add", "-q", "--detach", wt, target]);
    dir = wt;
    const merge = git(["merge", "--no-ff", "-q", "-m", message, head], { allowFail: true });
    if (!merge.ok) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split("\n").filter(Boolean);
      return { conflicts, output: merge.out.slice(0, 2000) };
    }
    const sha = git(["rev-parse", "HEAD"]).out;
    dir = repoDir;
    git(["update-ref", ontoRef(sha), sha]); // keep the object reachable until it's pushed
    return { sha };
  } finally {
    dir = prev;
    git(["worktree", "remove", "--force", wt], { allowFail: true });
  }
}

/**
 * Put `branch` back to `sha`, but only if it is still at `current` (force-with-lease): a later legitimate move, such
 * as a merge landing meanwhile, is never undone.
 */
/** Save `sha` (a commit of `branch`) under the hidden ref, so a later restore can fetch it after any force push. */
function keep(i: Extract<Input, { mode: "keep" }>) {
  if (!git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok) fetchBranch(i.repo, i.branch);
  if (!git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok) return { mode: "keep", kept: false, reason: `${i.sha.slice(0, 7)} isn't on ${i.branch}`, timings };
  const push = git([...LOW_SPEED, "push", "-q", "--force", i.repo.remote, `${i.sha}:${i.keepRef}`], { token: i.repo.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS });
  return push.ok ? { mode: "keep", kept: true, timings } : { mode: "keep", kept: false, reason: push.out.slice(-300), timings };
}

function restore(i: Extract<Input, { mode: "restore" }>) {
  // Where the branch is now ("" if it was deleted), from the remote itself.
  const ls = git([...LOW_SPEED, "ls-remote", i.repo.remote, `refs/heads/${i.branch}`], { token: i.repo.token, timeoutMs: FETCH_TIMEOUT_MS }).out.split(/\s/)[0] ?? "";
  if (ls !== i.current) return { mode: "restore", restored: false, reason: `${i.branch} is at ${ls.slice(0, 7) || "nothing"}, not ${i.current.slice(0, 7) || "nothing"}`, timings };
  // The protected commit may not be in a cold cache. Usually the bad push is on top of it, so fetching the branch
  // brings it; after a force push to another history, fetch it from its hidden ref (merges keep it there).
  if (i.current && !git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok) fetchBranch(i.repo, i.branch);
  if (!git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok && i.keepRef)
    withGitLock(() => git([...LOW_SPEED, "fetch", "-q", "--no-tags", i.repo.remote, `+${i.keepRef}:refs/atc-protected/${i.repo.name}`], { token: i.repo.token, allowFail: true, timeoutMs: FETCH_TIMEOUT_MS }));
  if (!git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok) return { mode: "restore", restored: false, reason: `the protected commit ${i.sha.slice(0, 7)} isn't available to push back`, timings };
  const push = timed("push restore", () => git([...LOW_SPEED, "push", "-q", `--force-with-lease=refs/heads/${i.branch}:${i.current}`, i.repo.remote, `${i.sha}:refs/heads/${i.branch}`], { token: i.repo.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS }));
  if (push.ok && i.keepRef) git([...LOW_SPEED, "push", "-q", "--force", i.repo.remote, `${i.sha}:${i.keepRef}`], { token: i.repo.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS });
  return push.ok ? { mode: "restore", restored: true, timings } : { mode: "restore", restored: false, reason: push.out.slice(-500), timings };
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
  if (input.mode === "restore") return restore(input);
  if (input.mode === "keep") return keep(input);
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

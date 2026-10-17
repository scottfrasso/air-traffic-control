// Runs inside the checker container (Node 24 strips the types natively; erasable syntax only).
// Input: JSON in the CHECK_INPUT env var. Output: one JSON line on stdout, prefixed with "@@RESULT ".
//
// Modes:
//   pair   typecheck fork A alone, fork B alone, then `git merge` B into A and typecheck the merge
//   single typecheck one ref
//   land   verify fork is current with baseline, typecheck it, fast-forward baseline main to it
//   notes  attach ATC's flight logs to landed commits as git notes under refs/notes/atc
// Review pipeline (worker/src/review):
//   snapshot  the repo at a PR's head as tar.gz, its diff, changed paths, and its .atc/* + REVIEW.md config
//   ci        run the repo's CI commands at a commit, each a check, bounded per command
//   merge     merge a PR branch onto its target, run CI on the result, push the target only if CI passes
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { landGuard } from "./guard.ts";

interface RepoRef { name: string; remote: string; token: string }
interface TsError { file: string; line: number; col: number; code: string; message: string; lineText: string }
interface Typecheck { sha: string; ok: boolean; errors: TsError[]; output: string; cached?: boolean; ms?: number }

type Input =
  | { mode: "single"; repo: RepoRef; baseline?: RepoRef }
  | { mode: "pair"; a: RepoRef; b: RepoRef; baseline?: RepoRef }
  | { mode: "land"; fork: RepoRef & { expectedHead?: string }; baseline: RepoRef & { expectedHead: string } }
  | { mode: "notes"; baseline: RepoRef; notes: Array<{ sha: string; note: string }> }
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
// Persistent cache (lives as long as the warm container): one repo whose object store accumulates every
// fork and baseline commit, so each check fetches only deltas; typecheck results keyed by git TREE hash;
// TypeScript incremental state computed once per baseline tree and reused by every check on top of it.
// ATC_CACHE / ATC_WORK exist for the local tests (worker/test/container.test.ts); the container uses the defaults.
const CACHE = process.env.ATC_CACHE ?? "/cache";
const WORK = process.env.ATC_WORK ?? "/work";
const repoDir = join(CACHE, "repo");
mkdirSync(join(CACHE, "tc"), { recursive: true });
mkdirSync(join(CACHE, "tsbuild"), { recursive: true });
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

/** Write to a temp file, then rename: a concurrent reader sees the old file or the whole new one, never half of it. */
function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

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
  const auth = ["-c", "gc.auto=0", ...(opts.token ? ["-c", `http.extraHeader=Authorization: Bearer ${opts.token}`] : [])];
  try {
    return {
      ok: true,
      out: execFileSync("git", [...auth, ...args], { cwd: dir, encoding: "utf8", stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input: opts.input, timeout: opts.timeoutMs }).trim(),
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (!opts.allowFail) throw new Error(`git ${args[0]} failed: ${out}`);
    return { ok: false, out };
  }
}

/** Fetch `main` of a repo into refs/agentmesh/<label>; returns the fetched sha. */
function fetchMain(repo: RepoRef, label: string): string {
  const ref = `refs/agentmesh/${repo.name}`;
  // Fetch and read the ref under one lock, so another check's fetch of the same repo can't move it in between.
  return withGitLock(() => {
    // Bounded: a stalled remote must not hold the lock (and every other check in this container) until the hard timeout.
    timed(`fetch ${label}`, () => git([...LOW_SPEED, "fetch", "-q", "--no-tags", repo.remote, `+refs/heads/main:${ref}`], { token: repo.token, timeoutMs: FETCH_TIMEOUT_MS }));
    return git(["rev-parse", ref]).out;
  });
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

/** The change of `sha` against `base` (three-dot, like a code host), or against `since` for a follow-up review. */
function changes(i: { repo: RepoRef; branch: string; target: string; sha: string; base: string | null; since?: string | null }) {
  fetchBranch(i.repo, i.target);
  fetchBranch(i.repo, i.branch);
  if (!git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok) throw new Error(`commit ${i.sha.slice(0, 7)} isn't on ${i.branch}`);
  const range = i.since ? [i.since, i.sha] : i.base ? [`${i.base}...${i.sha}`] : [`${i.sha}^`, i.sha];
  const diff = timed("diff", () => git(["diff", "--no-color", "--no-ext-diff", ...range]).out);
  const changedPaths = git(["diff", "--name-only", ...range]).out.split("\n").filter(Boolean);
  return { diff: diff ? `${diff}\n` : "", changedPaths };
}

function snapshot(i: Extract<Input, { mode: "snapshot" }>) {
  const { diff, changedPaths } = changes(i);
  const tarGz = timed("archive", () => execFileSync("git", ["archive", "--format=tar.gz", i.sha], { cwd: dir, maxBuffer: SNAPSHOT_MAX_BYTES * 2 }));
  if (tarGz.byteLength > SNAPSHOT_MAX_BYTES) throw new Error(`repository archive is ${Math.round(tarGz.byteLength / 1e6)} MB, over the ${SNAPSHOT_MAX_BYTES / 1e6} MB limit`);
  return {
    mode: "snapshot", sha: i.sha, diff, changedPaths, tarGzBase64: tarGz.toString("base64"),
    config: { ci: fileAt(i.sha, ".atc/ci.yml"), review: fileAt(i.sha, ".atc/review.yml"), owners: fileAt(i.sha, ".atc/owners"), reviewMd: fileAt(i.sha, "REVIEW.md") },
    timings,
  };
}

/** Run CI commands in a fresh worktree at `sha`, in order; the first failure stops the rest (shown as skipped). */
function runCi(sha: string, commands: CiCommand[]): CiCheck[] {
  const wt = mkdtempSync(join(WORK, "ci-"));
  const home = mkdtempSync(join(WORK, "ci-home-"));
  const out: CiCheck[] = [];
  try {
    git(["worktree", "add", "-q", "--detach", wt, sha]);
    let stopped = false;
    for (const c of commands) {
      if (stopped) {
        out.push({ name: c.name, status: "skipped", log: "not run: an earlier command failed", ms: 0 });
        continue;
      }
      progress(`ci ${c.name}`);
      const t = Date.now();
      // Only a minimal environment: the container's own variables (tokens, CHECK_INPUT) never reach repo code.
      const r = spawnSync("sh", ["-c", `exec 2>&1\n${c.run}`], {
        cwd: wt, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, CI: "true" },
        encoding: "utf8", timeout: c.timeoutSeconds * 1000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      });
      const ms = Date.now() - t;
      const timedOut = (r.error as { code?: string } | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
      const tail = (r.stdout ?? "").slice(-7800);
      if (timedOut) out.push({ name: c.name, status: "errored", log: `${tail}\n[timed out after ${c.timeoutSeconds} s]`, ms });
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

function ci(i: Extract<Input, { mode: "ci" }>) {
  fetchBranch(i.repo, i.branch);
  if (!git(["cat-file", "-e", `${i.sha}^{commit}`], { allowFail: true }).ok) throw new Error(`commit ${i.sha.slice(0, 7)} isn't on ${i.branch}`);
  return { mode: "ci", checks: runCi(i.sha, i.commands), timings };
}

/** Merge queue for a PR: source onto the target's current head, CI on that exact commit, then a fast-forward push. */
function merge(i: Extract<Input, { mode: "merge" }>) {
  const target = fetchBranch(i.repo, i.target);
  const source = fetchBranch(i.repo, i.source);
  if (source !== i.expectedSource) return { mode: "merge", merged: false, retry: true, reason: `${i.source} moved to ${source.slice(0, 7)} since it was reviewed (${i.expectedSource.slice(0, 7)})` };
  if (target !== i.expectedTarget) return { mode: "merge", merged: false, retry: true, reason: `${i.target} moved to ${target.slice(0, 7)}; merge again onto the new head`, targetHead: target };
  const onto = ontoBase(source, target, i.message);
  if ("conflicts" in onto) return { mode: "merge", merged: false, reason: `merge conflict with ${i.target} in ${onto.conflicts.join(", ")}`, conflicts: onto.conflicts };
  const checks = runCi(onto.sha, i.commands);
  if (checks.some((c) => c.status !== "passed" && c.status !== "skipped")) return { mode: "merge", merged: false, reason: "CI failed on the merged commit", checks, sha: onto.sha };
  const push = timed("push target", () => git([...LOW_SPEED, "push", "-q", i.repo.remote, `${onto.sha}:refs/heads/${i.target}`], { token: i.repo.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS }));
  if (!push.ok) return { mode: "merge", merged: false, retry: true, reason: `push to ${i.target} failed (${push.out.slice(0, 160)}); retry`, checks };
  return { mode: "merge", merged: true, sha: onto.sha, checks, timings };
}

const treeOf = (rev: string) => git(["rev-parse", `${rev}^{tree}`]).out;

/** Main's incremental TypeScript state for a baseline commit, computed once and cached by tree. */
function mainBuildInfo(baseSha: string | null): string | null {
  if (!baseSha) return null;
  const file = join(CACHE, "tsbuild", `${treeOf(baseSha)}.tsbuildinfo`);
  if (existsSync(file)) return file;
  // Concurrent checks of one push all need main's state at once: one builds it, the others wait and reuse it (issue #9).
  return withLock(`${file}.lock`, () => (existsSync(file) ? file : buildMainInfo(baseSha, file)));
}

function buildMainInfo(baseSha: string, file: string): string | null {
  const wt = mkdtempSync(join(WORK, "main-"));
  try {
    git(["worktree", "add", "-q", "--detach", wt, baseSha]);
    timed("build main incremental state", () => {
      try { execFileSync("tsc", ["--noEmit", "-p", ".", "--incremental", "--tsBuildInfoFile", ".atc.tsbuildinfo"], { cwd: wt, stdio: "ignore", timeout: TSC_TIMEOUT_MS, killSignal: "SIGKILL" }); } catch { /* main may not typecheck; state is still useful */ }
    });
    if (existsSync(join(wt, ".atc.tsbuildinfo"))) writeAtomic(file, readFileSync(join(wt, ".atc.tsbuildinfo")));
  } finally {
    git(["worktree", "remove", "--force", wt], { allowFail: true });
  }
  return existsSync(file) ? file : null;
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

// tsc 7 reports diagnostics with exit 1; exit 2 from the Go binary is a crash, whose partial output must not be cached.
const isTscOutcome = (ok: boolean, exit: number | null, errors: number) => ok || (exit === 1 && errors > 0);

const prOf = (name: string) => (/--pr(\d+)$/.exec(name) ? `PR${/--pr(\d+)$/.exec(name)![1]}` : name);

/** Typecheck a commit in a throwaway worktree. Results are cached by tree hash; main's incremental state seeds tsc. */
function typecheck(rev: string, label: string, buildInfo: string | null): Typecheck {
  const sha = git(["rev-parse", rev]).out;
  const tree = treeOf(sha);
  const cacheFile = join(CACHE, "tc", `${tree}.json`);
  const cached = () => {
    timings.push({ step: `typecheck ${label}`, ms: 0, cached: true });
    return { ...(JSON.parse(readFileSync(cacheFile, "utf8")) as Typecheck), sha, cached: true, ms: 0 };
  };
  if (existsSync(cacheFile)) return cached();
  // Another check of this push may be typechecking the same tree right now (the fork alone, in every pair): wait for
  // its result instead of running tsc again (issue #9). An uncached outcome (environment failure) is recomputed.
  return withLock(`${cacheFile}.lock`, () => (existsSync(cacheFile) ? cached() : runTypecheck(sha, label, buildInfo, cacheFile)));
}

function runTypecheck(sha: string, label: string, buildInfo: string | null, cacheFile: string): Typecheck {
  const wt = mkdtempSync(join(WORK, "check-"));
  const started = Date.now();
  try {
    git(["worktree", "add", "-q", "--detach", wt, sha]);
    const args = ["--noEmit", "-p", ".", "--pretty", "false"];
    if (buildInfo) {
      copyFileSync(buildInfo, join(wt, ".atc.tsbuildinfo"));
      args.push("--incremental", "--tsBuildInfoFile", ".atc.tsbuildinfo");
    }
    let output = "";
    let ok = true;
    let exit: number | null = 0;
    try {
      // Bounded below the hard timeout: a hung tsc fails this check with a reason (and isn't cached), instead of
      // silently using up the whole run.
      output = execFileSync("tsc", args, { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: TSC_TIMEOUT_MS, killSignal: "SIGKILL" });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number | null };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      ok = false;
      exit = e.status ?? null; // null: killed by a signal (timeout)
      if (exit === null) {
        progress(`tsc killed after ${Math.round((Date.now() - started) / 1000)}s (${label})`);
        output = `tsc did not finish within ${TSC_TIMEOUT_MS / 1000} s and was killed. ${output}`.trim();
      }
    }
    const errors: TsError[] = [];
    for (const line of output.split("\n")) {
      const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
      if (!m) continue;
      const [, file = "", l = "0", c = "0", code = "", message = ""] = m;
      let lineText = "";
      try {
        lineText = (readFileSync(join(wt, file), "utf8").split("\n")[Number(l) - 1] ?? "").trim();
      } catch { /* file may not exist */ }
      errors.push({ file, line: Number(l), col: Number(c), code, message, lineText });
    }
    const result: Typecheck = { sha, ok: ok && errors.length === 0, errors, output: output.slice(0, 4000) };
    // Cache only real tsc outcomes: a pass, or tsc's own diagnostics (exit 1). A crash, a kill or a missing tsc is
    // the environment, not the code; caching it by tree hash would make a transient failure permanent (issue #8).
    if (isTscOutcome(ok, exit, errors.length)) writeAtomic(cacheFile, JSON.stringify(result));
    const ms = Date.now() - started;
    timings.push({ step: `typecheck ${label}`, ms, cached: false });
    return { ...result, cached: false, ms };
  } finally {
    git(["worktree", "remove", "--force", wt], { allowFail: true });
  }
}

/** Fail a stalled transfer after 10 s below 1 KB/s, instead of hanging until the checker's hard timeout. */
const LOW_SPEED = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=10"];
const NOTE_TIMEOUT_MS = 30_000;
/** One tsc run; well below the checker's hard timeout (240 s), so the run can still report. */
const TSC_TIMEOUT_MS = Number(process.env.ATC_TSC_TIMEOUT_MS) || 150_000; // env: tests only
const PUSH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Add flight log notes to the baseline's refs/notes/atc. ATC calls this in the background after it has recorded the
 * landing (one writer per Coordinator), and retries what fails. Idempotent: a note whose text is already there is
 * skipped, so a retry after a push that did land can't duplicate it. The push is never forced, so nothing is overwritten.
 * The local ref is per baseline.
 */
function writeNotes(base: RepoRef, notes: Array<{ sha: string; note: string }>): { mode: "notes"; written: string[]; error?: string } {
  const local = `refs/notes/agentmesh-${base.name}`;
  git(["update-ref", "-d", local], { allowFail: true });
  const fetch = git([...LOW_SPEED, "fetch", "-q", "--no-tags", base.remote, `+refs/notes/atc:${local}`], { token: base.token, allowFail: true, timeoutMs: NOTE_TIMEOUT_MS });
  // Only "no notes yet" may start a new notes history; any other fetch error would make the push diverge.
  if (!fetch.ok && !/couldn't find remote ref/i.test(fetch.out)) return { mode: "notes", written: [], error: `fetch refs/notes/atc: ${fetch.out.slice(0, 200)}` };
  for (const n of notes) {
    // Never replace a note: a PR that added nothing new lands on an existing commit that already has one. Append instead.
    const existing = git(["notes", `--ref=${local}`, "show", n.sha], { allowFail: true });
    if (existing.ok && existing.out.includes(n.note.trim())) continue; // already written (a retry after a push that landed)
    const has = existing.ok;
    const add = git(["notes", `--ref=${local}`, has ? "append" : "add", "-F", "-", n.sha], { allowFail: true, input: n.note });
    if (!add.ok) return { mode: "notes", written: [], error: `notes add ${n.sha.slice(0, 7)}: ${add.out.slice(0, 200)}` };
  }
  const push = timed("push notes", () => git([...LOW_SPEED, "push", "-q", base.remote, `${local}:refs/notes/atc`], { token: base.token, allowFail: true, timeoutMs: NOTE_TIMEOUT_MS }));
  return push.ok ? { mode: "notes", written: notes.map((n) => n.sha) } : { mode: "notes", written: [], error: `push refs/notes/atc: ${push.out.slice(0, 200)}` };
}

function run(): unknown {
  if (input.mode === "notes") return writeNotes(input.baseline, input.notes);
  if (input.mode === "snapshot") return snapshot(input);
  if (input.mode === "diff") return { mode: "diff", ...changes(input), timings };
  if (input.mode === "ci") return ci(input);
  if (input.mode === "merge") return merge(input);
  if (input.mode === "single") {
    // "Green" means: this PR, merged onto the CURRENT main, typechecks. That's what would land.
    const base = input.baseline ? fetchMain(input.baseline, "baseline") : null;
    const sha = fetchMain(input.repo, "fork");
    if (!base) return { mode: "single", repo: input.repo.name, forkSha: sha, baseHead: null, result: typecheck(sha, "fork", null), timings };
    const onto = ontoBase(sha, base, `Land ${prOf(input.repo.name)} via ATC`);
    if ("conflicts" in onto) {
      return {
        mode: "single", repo: input.repo.name, forkSha: sha, baseHead: base, mainConflict: true,
        result: { sha, ok: false, errors: [], output: `merge conflict with main in ${onto.conflicts.join(", ")}` }, timings,
      };
    }
    const result = typecheck(onto.sha, "on main", mainBuildInfo(base));
    const alone = result.ok || onto.sha === sha ? null : typecheck(sha, "alone", mainBuildInfo(base));
    return { mode: "single", repo: input.repo.name, forkSha: sha, baseHead: base, mainConflict: !result.ok && alone?.ok === true, result, timings };
  }
  if (input.mode === "pair") {
    const base = input.baseline ? fetchMain(input.baseline, "baseline") : null;
    const a = fetchMain(input.a, "a");
    const b = fetchMain(input.b, "b");
    const info = mainBuildInfo(base);
    const aloneA = typecheck(a, "A alone", info);
    const aloneB = typecheck(b, "B alone", info);
    // Merge B into A in a scratch worktree (no checkout of the shared cache repo).
    const mwt = mkdtempSync(join(WORK, "merge-"));
    try {
      git(["worktree", "add", "-q", "--detach", mwt, a]);
      const merge = (() => { const prev = dir; dir = mwt; try { return git(["merge", "--no-edit", "-q", b], { allowFail: true }); } finally { dir = prev; } })();
      if (!merge.ok) {
        dir = mwt;
        const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split("\n").filter(Boolean);
        dir = repoDir;
        return { mode: "pair", a: input.a.name, b: input.b.name, aloneA, aloneB, merge: { clean: false, conflicts, output: merge.out.slice(0, 2000) }, timings };
      }
      dir = mwt;
      const mergedSha = git(["rev-parse", "HEAD"]).out;
      dir = repoDir;
      git(["update-ref", `refs/agentmesh/merge-${a.slice(0, 12)}-${b.slice(0, 12)}`, mergedSha]);
      const merged = typecheck(mergedSha, "merge", info);
      return { mode: "pair", a: input.a.name, b: input.b.name, aloneA, aloneB, merge: { clean: true, conflicts: [], typecheck: merged }, timings };
    } finally {
      dir = repoDir;
      git(["worktree", "remove", "--force", mwt], { allowFail: true });
    }
  }
  // land: merge queue. Put the PR on top of the current main, typecheck that exact commit, push it.
  const baseHead = fetchMain(input.baseline, "base");
  const forkHead = fetchMain(input.fork, "fork");
  const moved = landGuard(baseHead, input.baseline.expectedHead, forkHead, input.fork.expectedHead);
  if (moved) return { mode: "land", landed: false, retry: true, reason: moved, forkHead, baseHead };
  const onto = ontoBase(forkHead, baseHead, `Land ${prOf(input.fork.name)} via ATC`);
  if ("conflicts" in onto) return { mode: "land", landed: false, mainConflict: true, reason: `merge conflict with main in ${onto.conflicts.join(", ")}`, forkHead, baseHead };
  const check = typecheck(onto.sha, "land", mainBuildInfo(baseHead));
  if (!check.ok) return { mode: "land", landed: false, mainConflict: true, reason: "PR merged onto current main fails typecheck", forkHead, baseHead, typecheck: check };
  const push = timed("push main", () => git([...LOW_SPEED, "push", "-q", input.baseline.remote, `${onto.sha}:refs/heads/main`], { token: input.baseline.token, allowFail: true, timeoutMs: PUSH_TIMEOUT_MS }));
  if (!push.ok) return { mode: "land", landed: false, retry: true, reason: `push to main failed (${push.out.slice(0, 120)}); retry`, forkHead, baseHead };
  return { mode: "land", landed: true, forkHead, landedSha: onto.sha, merged: onto.sha !== forkHead, previousHead: baseHead, typecheck: check, timings };
}

try {
  const result = run() as { timings?: unknown[] };
  // Wall time of the whole check, including waits for locks and cached results (steps alone miss those; review of #36).
  if (Array.isArray(result.timings)) result.timings.push({ step: "total", ms: Date.now() - startedAt });
  console.log(`@@RESULT ${JSON.stringify(result)}`);
} catch (err) {
  console.log(`@@RESULT ${JSON.stringify({ error: (err as Error).message })}`);
} finally {
  git(["worktree", "prune"], { allowFail: true });
}

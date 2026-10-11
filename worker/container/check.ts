// Runs inside the checker container (Node 24 strips the types natively; erasable syntax only).
// Input: JSON in the CHECK_INPUT env var. Output: one JSON line on stdout, prefixed with "@@RESULT ".
//
// Modes:
//   pair   typecheck fork A alone, fork B alone, then `git merge` B into A and typecheck the merge
//   single typecheck one ref
//   land   verify fork is current with baseline, typecheck it, fast-forward baseline main to it
//   notes  attach ATC's flight logs to landed commits as git notes under refs/notes/atc
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { landGuard } from "./guard.ts";

interface RepoRef { name: string; remote: string; token: string }
interface TsError { file: string; line: number; col: number; code: string; message: string; lineText: string }
interface Typecheck { sha: string; ok: boolean; errors: TsError[]; output: string; cached?: boolean; ms?: number }

type Input =
  | { mode: "single"; repo: RepoRef; baseline?: RepoRef }
  | { mode: "pair"; a: RepoRef; b: RepoRef; baseline?: RepoRef }
  | { mode: "land"; fork: RepoRef & { expectedHead?: string }; baseline: RepoRef & { expectedHead: string } }
  | { mode: "notes"; baseline: RepoRef; notes: Array<{ sha: string; note: string }> };

const input = JSON.parse(process.env.CHECK_INPUT ?? "{}") as Input;
// Persistent cache (lives as long as the warm container): one repo whose object store accumulates every
// fork and baseline commit, so each check fetches only deltas; typecheck results keyed by git TREE hash;
// TypeScript incremental state computed once per baseline tree and reused by every check on top of it.
const CACHE = "/cache";
const repoDir = join(CACHE, "repo");
mkdirSync(join(CACHE, "tc"), { recursive: true });
mkdirSync(join(CACHE, "tsbuild"), { recursive: true });
if (!existsSync(join(repoDir, ".git"))) {
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
}
let dir = repoDir; // git commands run here; typechecks run in throwaway worktrees
const timings: Array<{ step: string; ms: number; cached?: boolean }> = [];
const timed = <T,>(step: string, fn: () => T): T => { const t = Date.now(); const r = fn(); timings.push({ step, ms: Date.now() - t }); return r; };

function git(args: string[], opts: { token?: string; allowFail?: boolean; input?: string; timeoutMs?: number } = {}): { ok: boolean; out: string } {
  const auth = opts.token ? ["-c", `http.extraHeader=Authorization: Bearer ${opts.token}`] : [];
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
  timed(`fetch ${label}`, () => git(["fetch", "-q", "--no-tags", repo.remote, `+refs/heads/main:${ref}`], { token: repo.token }));
  return git(["rev-parse", ref]).out;
}

const treeOf = (rev: string) => git(["rev-parse", `${rev}^{tree}`]).out;

/** Main's incremental TypeScript state for a baseline commit, computed once and cached by tree. */
function mainBuildInfo(baseSha: string | null): string | null {
  if (!baseSha) return null;
  const file = join(CACHE, "tsbuild", `${treeOf(baseSha)}.tsbuildinfo`);
  if (existsSync(file)) return file;
  const wt = mkdtempSync("/work/main-");
  try {
    git(["worktree", "add", "-q", "--detach", wt, baseSha]);
    timed("build main incremental state", () => {
      try { execFileSync("tsc", ["--noEmit", "-p", ".", "--incremental", "--tsBuildInfoFile", ".atc.tsbuildinfo"], { cwd: wt, stdio: "ignore" }); } catch { /* main may not typecheck; state is still useful */ }
    });
    if (existsSync(join(wt, ".atc.tsbuildinfo"))) copyFileSync(join(wt, ".atc.tsbuildinfo"), file);
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
  const wt = mkdtempSync("/work/onto-");
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

const prOf = (name: string) => (/--pr(\d+)$/.exec(name) ? `PR${/--pr(\d+)$/.exec(name)![1]}` : name);

/** Typecheck a commit in a throwaway worktree. Results are cached by tree hash; main's incremental state seeds tsc. */
function typecheck(rev: string, label: string, buildInfo: string | null): Typecheck {
  const sha = git(["rev-parse", rev]).out;
  const tree = treeOf(sha);
  const cacheFile = join(CACHE, "tc", `${tree}.json`);
  if (existsSync(cacheFile)) {
    timings.push({ step: `typecheck ${label}`, ms: 0, cached: true });
    return { ...(JSON.parse(readFileSync(cacheFile, "utf8")) as Typecheck), sha, cached: true, ms: 0 };
  }
  const wt = mkdtempSync("/work/check-");
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
    try {
      output = execFileSync("tsc", args, { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      ok = false;
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
    writeFileSync(cacheFile, JSON.stringify(result));
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

/**
 * Add flight log notes to the baseline's refs/notes/atc. ATC calls this after it has recorded the landing (still under
 * the landing lock), so a slow or failed note never leaves a landed PR unrecorded. The push is never forced: if it is
 * rejected, nothing is overwritten and ATC retries those notes on the next landing. The local ref is per baseline.
 */
function writeNotes(base: RepoRef, notes: Array<{ sha: string; note: string }>): { mode: "notes"; written: string[]; error?: string } {
  const local = `refs/notes/agentmesh-${base.name}`;
  git(["update-ref", "-d", local], { allowFail: true });
  const fetch = git([...LOW_SPEED, "fetch", "-q", "--no-tags", base.remote, `+refs/notes/atc:${local}`], { token: base.token, allowFail: true, timeoutMs: NOTE_TIMEOUT_MS });
  // Only "no notes yet" may start a new notes history; any other fetch error would make the push diverge.
  if (!fetch.ok && !/couldn't find remote ref/i.test(fetch.out)) return { mode: "notes", written: [], error: `fetch refs/notes/atc: ${fetch.out.slice(0, 200)}` };
  for (const n of notes) {
    // Never replace a note: a PR that added nothing new lands on an existing commit that already has one. Append instead.
    const has = git(["notes", `--ref=${local}`, "show", n.sha], { allowFail: true }).ok;
    const add = git(["notes", `--ref=${local}`, has ? "append" : "add", "-F", "-", n.sha], { allowFail: true, input: n.note });
    if (!add.ok) return { mode: "notes", written: [], error: `notes add ${n.sha.slice(0, 7)}: ${add.out.slice(0, 200)}` };
  }
  const push = timed("push notes", () => git([...LOW_SPEED, "push", "-q", base.remote, `${local}:refs/notes/atc`], { token: base.token, allowFail: true, timeoutMs: NOTE_TIMEOUT_MS }));
  return push.ok ? { mode: "notes", written: notes.map((n) => n.sha) } : { mode: "notes", written: [], error: `push refs/notes/atc: ${push.out.slice(0, 200)}` };
}

function run(): unknown {
  if (input.mode === "notes") return writeNotes(input.baseline, input.notes);
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
    const mwt = mkdtempSync("/work/merge-");
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
  const push = git(["push", "-q", input.baseline.remote, `${onto.sha}:refs/heads/main`], { token: input.baseline.token, allowFail: true });
  if (!push.ok) return { mode: "land", landed: false, retry: true, reason: `push to main failed (${push.out.slice(0, 120)}); retry`, forkHead, baseHead };
  return { mode: "land", landed: true, forkHead, landedSha: onto.sha, merged: onto.sha !== forkHead, previousHead: baseHead, typecheck: check, timings };
}

try {
  console.log(`@@RESULT ${JSON.stringify(run())}`);
} catch (err) {
  console.log(`@@RESULT ${JSON.stringify({ error: (err as Error).message })}`);
} finally {
  git(["worktree", "prune"], { allowFail: true });
}

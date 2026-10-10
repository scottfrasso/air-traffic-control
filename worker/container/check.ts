// Runs inside the checker container (Node 24 strips the types natively; erasable syntax only).
// Input: JSON in the CHECK_INPUT env var. Output: one JSON line on stdout, prefixed with "@@RESULT ".
//
// Modes:
//   pair   typecheck fork A alone, fork B alone, then `git merge` B into A and typecheck the merge
//   single typecheck one ref
//   land   verify fork is current with baseline, typecheck it, fast-forward baseline main to it
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

interface RepoRef { name: string; remote: string; token: string; sha?: string }
interface TsError { file: string; line: number; col: number; code: string; message: string; lineText: string }
interface Typecheck { sha: string; ok: boolean; errors: TsError[]; output: string }

type Input =
  | { mode: "single"; repo: RepoRef }
  | { mode: "pair"; a: RepoRef; b: RepoRef }
  | { mode: "land"; fork: RepoRef; baseline: RepoRef & { expectedHead: string } };

const input = JSON.parse(process.env.CHECK_INPUT ?? "{}") as Input;
const dir = mkdtempSync("/work/check-");

function git(args: string[], opts: { token?: string; allowFail?: boolean } = {}): { ok: boolean; out: string } {
  const auth = opts.token ? ["-c", `http.extraHeader=Authorization: Bearer ${opts.token}`] : [];
  try {
    return { ok: true, out: execFileSync("git", [...auth, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (!opts.allowFail) throw new Error(`git ${args[0]} failed: ${out}`);
    return { ok: false, out };
  }
}

/** Fetch `main` of a repo into refs/agentmesh/<label>; returns the fetched sha. */
function fetchMain(repo: RepoRef, label: string): string {
  git(["fetch", "-q", "--no-tags", repo.remote, `+refs/heads/main:refs/agentmesh/${label}`], { token: repo.token });
  return git(["rev-parse", `refs/agentmesh/${label}`]).out;
}

function typecheck(ref: string): Typecheck {
  git(["checkout", "-q", "--force", "--detach", ref]);
  git(["clean", "-qfdx"]);
  const sha = git(["rev-parse", "HEAD"]).out;
  let output = "";
  let ok = true;
  try {
    output = execFileSync("tsc", ["--noEmit", "-p", ".", "--pretty", "false"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
      lineText = (readFileSync(join(dir, file), "utf8").split("\n")[Number(l) - 1] ?? "").trim();
    } catch { /* file may not exist */ }
    errors.push({ file, line: Number(l), col: Number(c), code, message, lineText });
  }
  return { sha, ok: ok && errors.length === 0, errors, output: output.slice(0, 4000) };
}

function run(): unknown {
  git(["init", "-q"]);
  if (input.mode === "single") {
    const sha = fetchMain(input.repo, "x");
    return { mode: "single", repo: input.repo.name, result: typecheck(sha) };
  }
  if (input.mode === "pair") {
    const a = fetchMain(input.a, "a");
    const b = fetchMain(input.b, "b");
    const aloneA = typecheck(a);
    const aloneB = typecheck(b);
    git(["checkout", "-q", "--force", "--detach", a]);
    const merge = git(["merge", "--no-edit", "-q", b], { allowFail: true });
    if (!merge.ok) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split("\n").filter(Boolean);
      git(["merge", "--abort"], { allowFail: true });
      return { mode: "pair", a: input.a.name, b: input.b.name, aloneA, aloneB, merge: { clean: false, conflicts, output: merge.out.slice(0, 2000) } };
    }
    const merged = typecheck("HEAD");
    return { mode: "pair", a: input.a.name, b: input.b.name, aloneA, aloneB, merge: { clean: true, conflicts: [], typecheck: merged } };
  }
  // land
  const baseHead = fetchMain(input.baseline, "base");
  if (baseHead !== input.baseline.expectedHead) return { mode: "land", landed: false, reason: `baseline moved: expected ${input.baseline.expectedHead.slice(0, 7)}, found ${baseHead.slice(0, 7)}` };
  const forkHead = fetchMain(input.fork, "fork");
  const current = git(["merge-base", "--is-ancestor", baseHead, forkHead], { allowFail: true }).ok;
  if (!current) return { mode: "land", landed: false, reason: "fork is not current with baseline (rebase required)", forkHead, baseHead };
  const check = typecheck(forkHead);
  if (!check.ok) return { mode: "land", landed: false, reason: "fork does not typecheck", forkHead, baseHead, typecheck: check };
  const push = git(["push", "-q", input.baseline.remote, `${forkHead}:refs/heads/main`], { token: input.baseline.token, allowFail: true });
  if (!push.ok) return { mode: "land", landed: false, reason: `push to baseline failed: ${push.out}`, forkHead, baseHead };
  return { mode: "land", landed: true, forkHead, previousHead: baseHead, typecheck: check };
}

try {
  console.log(`@@RESULT ${JSON.stringify(run())}`);
} catch (err) {
  console.log(`@@RESULT ${JSON.stringify({ error: (err as Error).message })}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

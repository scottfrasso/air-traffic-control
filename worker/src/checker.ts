import { DurableObject } from "cloudflare:workers";
import { CHECK_TIMEOUT_S } from "./landing";

/** What container/check.ts accepts (tokens are short-lived Artifacts repo tokens). */
export interface RepoRef {
  name: string;
  remote: string;
  token: string;
}
export type CheckInput =
  | { mode: "single"; repo: RepoRef; baseline?: RepoRef }
  | { mode: "pair"; a: RepoRef; b: RepoRef; baseline?: RepoRef }
  | { mode: "land"; fork: RepoRef & { expectedHead: string }; baseline: RepoRef & { expectedHead: string } }
  | { mode: "notes"; baseline: RepoRef; notes: Array<{ sha: string; note: string }> }
  | { mode: "snapshot"; repo: RepoRef; branch: string; target: string; sha: string; base: string | null; since?: string | null }
  | { mode: "ci"; repo: RepoRef; branch: string; sha: string; commands: Array<{ name: string; run: string; timeoutSeconds: number }> }
  | { mode: "merge"; repo: RepoRef; source: string; target: string; expectedSource: string; expectedTarget: string; message: string; commands: Array<{ name: string; run: string; timeoutSeconds: number }> };

/**
 * How long one container run may take before it's killed. CI and merges run the repo's own commands (each bounded by
 * its own timeout), so they get the sum plus slack for fetching, capped at an hour; everything else the fixed limit.
 */
export function runTimeoutSeconds(input: CheckInput): number {
  if (input.mode === "ci" || input.mode === "merge") return Math.min(3600, 120 + input.commands.reduce((s, c) => s + c.timeoutSeconds, 0));
  return CHECK_TIMEOUT_S;
}

export interface TsError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
  lineText: string;
}
export interface Typecheck {
  sha: string;
  ok: boolean;
  errors: TsError[];
  output: string;
  /** True when served from the container's tree-hash cache. */
  cached?: boolean;
  ms?: number;
}
export type Timing = { step: string; ms: number; cached?: boolean };
export interface PairResult {
  mode: "pair";
  a: string;
  b: string;
  aloneA: Typecheck;
  aloneB: Typecheck;
  merge: { clean: boolean; conflicts: string[]; output?: string; typecheck?: Typecheck };
  timings?: Timing[];
}
export interface SingleResult {
  mode: "single";
  repo: string;
  /** The fork head that was checked (result.sha may be the PR merged onto main). */
  forkSha: string;
  /** Main commit the PR was merged onto for the check (null if no baseline given). */
  baseHead: string | null;
  /** True when the PR is fine alone but conflicts with current main (textually or by typecheck). */
  mainConflict?: boolean;
  result: Typecheck;
  timings?: Timing[];
}
export interface LandResult {
  mode: "land";
  landed: boolean;
  retry?: boolean;
  mainConflict?: boolean;
  landedSha?: string;
  merged?: boolean;
  reason?: string;
  forkHead?: string;
  previousHead?: string;
  baseHead?: string;
  typecheck?: Typecheck;
}
export interface NotesResult {
  mode: "notes";
  /** Landed commits whose flight log note reached refs/notes/atc. */
  written: string[];
  error?: string;
}

const decoder = new TextDecoder();

/**
 * The Sandbox: a Durable Object that owns one container (Sandbox SDK 1.0 model, ADR-0010) where we
 * clone forks, `git merge` them, and run `tsc --noEmit`. One Checker per baseline keeps the container warm.
 */
export class Checker extends DurableObject<Env> {
  private async container(): Promise<Container> {
    const c = this.ctx.container;
    if (!c) throw new Error("container not configured for Checker");
    if (!c.running) {
      const image = c.images.checker;
      if (!image) throw new Error("checker image missing from wrangler containers.images");
      c.start({ image, enableInternet: true, instance: "standard-3" }); // 2 vCPU: several merges + tsc run concurrently
    }
    await c.setInactivityTimeout(10 * 60_000);
    return c;
  }

  /** Run one check; returns the JSON result as a string (keeps the RPC boundary simple). */
  async run(input: CheckInput): Promise<string> {
    const c = await this.container();
    const proc = await c.exec(["timeout", "--kill-after=5", String(runTimeoutSeconds(input)), "node", "/opt/agentmesh/check.ts"], {
      env: { CHECK_INPUT: JSON.stringify(input), PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    const out = await proc.output();
    const stdout = decoder.decode(out.stdout);
    const line = stdout.split("\n").find((l) => l.startsWith("@@RESULT "));
    if (!line) {
      // The END of stderr says where it stopped (check.ts writes its steps and lock waits there). After the hard
      // timeout (exit 124), also list what is still running in the container: the hung process is in it.
      const stderr = decoder.decode(out.stderr).trim();
      let ps = "";
      if (out.exitCode === 124) {
        try {
          const p = await (await c.exec(["ps", "-eo", "pid,ppid,stat,etimes,args", "--sort=start_time"], { env: { PATH: "/usr/local/bin:/usr/bin:/bin" } })).output();
          ps = decoder.decode(p.stdout).split("\n").filter((l) => !/\bps -eo\b/.test(l)).slice(-15).join(" | ").slice(0, 1200);
        } catch (err) {
          ps = `ps failed: ${(err as Error).message}`;
        }
      }
      const detail = `checker produced no result (exit ${out.exitCode}): ${stderr.slice(-900)}${ps ? ` || ps: ${ps}` : ""}`;
      console.error(detail);
      throw new Error(detail);
    }
    return line.slice("@@RESULT ".length);
  }
}

/**
 * Pick one of a small pool of Checkers per baseline. Pushes spread over the pool by fork, and all of one push's checks
 * (its check on main and its pair checks) share a container, so main's build and the fork's results are reused.
 */
export function checkerFor(env: Env, baseline: string, key: string): DurableObjectStub<Checker> {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return env.CHECKER.getByName(`checker-${baseline}-${h % CHECKER_POOL}`);
}
export const CHECKER_POOL = 3;

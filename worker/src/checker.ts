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
  | { mode: "land"; fork: RepoRef & { expectedHead: string }; baseline: RepoRef & { expectedHead: string }; note?: string };

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
  /** Whether the flight log note reached refs/notes/atc (a failure never undoes the landing). */
  note?: { ok: boolean; error?: string };
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
    const proc = await c.exec(["timeout", "--kill-after=5", String(CHECK_TIMEOUT_S), "node", "/opt/agentmesh/check.ts"], {
      env: { CHECK_INPUT: JSON.stringify(input), PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    const out = await proc.output();
    const stdout = decoder.decode(out.stdout);
    const line = stdout.split("\n").find((l) => l.startsWith("@@RESULT "));
    if (!line) throw new Error(`checker produced no result (exit ${out.exitCode}): ${decoder.decode(out.stderr).slice(0, 500)}`);
    return line.slice("@@RESULT ".length);
  }
}

/** Pick one of a small pool of Checkers per baseline, so concurrent pair checks spread over containers. */
export function checkerFor(env: Env, baseline: string, key: string): DurableObjectStub<Checker> {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return env.CHECKER.getByName(`checker-${baseline}-${h % CHECKER_POOL}`);
}
export const CHECKER_POOL = 3;

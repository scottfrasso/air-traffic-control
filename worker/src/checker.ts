import { DurableObject } from "cloudflare:workers";

/** What container/check.ts accepts (tokens are short-lived Artifacts repo tokens). */
export interface RepoRef {
  name: string;
  remote: string;
  token: string;
}
export type CheckInput =
  | { mode: "single"; repo: RepoRef }
  | { mode: "pair"; a: RepoRef; b: RepoRef }
  | { mode: "land"; fork: RepoRef; baseline: RepoRef & { expectedHead: string } };

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
}
export interface PairResult {
  mode: "pair";
  a: string;
  b: string;
  aloneA: Typecheck;
  aloneB: Typecheck;
  merge: { clean: boolean; conflicts: string[]; output?: string; typecheck?: Typecheck };
}
export interface SingleResult {
  mode: "single";
  repo: string;
  result: Typecheck;
}
export interface LandResult {
  mode: "land";
  landed: boolean;
  reason?: string;
  forkHead?: string;
  previousHead?: string;
  baseHead?: string;
  typecheck?: Typecheck;
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
      c.start({ image, enableInternet: true, instance: "standard-1" });
    }
    await c.setInactivityTimeout(10 * 60_000);
    return c;
  }

  /** Run one check; returns the JSON result as a string (keeps the RPC boundary simple). */
  async run(input: CheckInput): Promise<string> {
    const c = await this.container();
    const proc = await c.exec(["timeout", "--kill-after=5", "240", "node", "/opt/agentmesh/check.ts"], {
      env: { CHECK_INPUT: JSON.stringify(input), PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    const out = await proc.output();
    const stdout = decoder.decode(out.stdout);
    const line = stdout.split("\n").find((l) => l.startsWith("@@RESULT "));
    if (!line) throw new Error(`checker produced no result (exit ${out.exitCode}): ${decoder.decode(out.stderr).slice(0, 500)}`);
    return line.slice("@@RESULT ".length);
  }
}

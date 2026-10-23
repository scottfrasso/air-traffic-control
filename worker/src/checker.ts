import { DurableObject } from "cloudflare:workers";

/** What container/check.ts accepts (tokens are short-lived Artifacts repo tokens, minted per call). */
export interface RepoRef {
  name: string;
  remote: string;
  token: string;
}

type CiCommand = { name: string; run: string; timeoutSeconds: number };

export type CheckInput =
  | { mode: "snapshot"; repo: RepoRef; branch: string; target: string; sha: string; base: string | null; since?: string | null }
  | { mode: "diff"; repo: RepoRef; branch: string; target: string; sha: string; base: string | null }
  | { mode: "ci"; repo: RepoRef; branch: string; sha: string; commands: CiCommand[] }
  | { mode: "merge"; repo: RepoRef; source: string; target: string; expectedSource: string; expectedTarget: string; message: string; commands: CiCommand[]; keepRef?: string }
  | { mode: "restore"; repo: RepoRef; branch: string; sha: string; current: string; keepRef?: string };

/** Hard limit on a container run that doesn't run the repo's own commands (snapshot, diff). */
export const CHECK_TIMEOUT_S = 240;

/**
 * How long one container run may take before it's killed. CI and merges run the repo's own commands (each bounded by
 * its own timeout), so they get the sum plus slack for fetching, capped at an hour; everything else the fixed limit.
 */
export function runTimeoutSeconds(input: CheckInput): number {
  if (input.mode === "ci" || input.mode === "merge") return Math.min(3600, 120 + input.commands.reduce((s, c) => s + c.timeoutSeconds, 0));
  return CHECK_TIMEOUT_S;
}

const decoder = new TextDecoder();

/**
 * The checker: a Durable Object that owns one container (ADR-0010), one per repo ("review-<repo>"), where we fetch
 * branches, build snapshots, run CI commands and merge. Kept warm so fetches are incremental.
 */
export class Checker extends DurableObject<Env> {
  private async container(): Promise<Container> {
    const c = this.ctx.container;
    if (!c) throw new Error("container not configured for Checker");
    if (!c.running) {
      const image = c.images.checker;
      if (!image) throw new Error("checker image missing from wrangler containers.images");
      c.start({ image, enableInternet: true, instance: "standard-3" }); // 2 vCPU: CI commands and git in parallel
    }
    await c.setInactivityTimeout(10 * 60_000);
    return c;
  }

  /** Run one job; returns the JSON result as a string (keeps the RPC boundary simple). */
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

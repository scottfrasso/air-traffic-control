import type { AgentClient } from "./agents/client";
import type { RepoRef } from "../checker";
import type { Snapshot } from "./orchestrate";
import type { Pr } from "./types";

/**
 * Build a run's snapshot in the checker container (git archive + diff + config, at the PR's head) and upload it
 * once for every session of the run: repo.tar.gz, diff.patch, pr.json. Sessions never get a repo credential;
 * the container's short-lived read token stays on our side.
 */
export async function buildSnapshot(opts: {
  /** checker.run for the snapshot mode (stubbed in tests). */
  run: (input: unknown) => Promise<string>;
  ref: RepoRef;
  agents: AgentClient;
  pr: Pr;
  sha: string;
  since: string | null;
}): Promise<Snapshot> {
  const { pr } = opts;
  const out = JSON.parse(
    await opts.run({ mode: "snapshot", repo: opts.ref, branch: pr.source, target: pr.target, sha: opts.sha, base: pr.base, since: opts.since }),
  ) as { error?: string; diff: string; changedPaths: string[]; tarGzBase64: string; config: Snapshot["config"] };
  if (out.error) throw new Error(`snapshot failed: ${out.error}`);
  const tar = Uint8Array.from(atob(out.tarGzBase64), (c) => c.charCodeAt(0));
  const intent = JSON.stringify({ id: pr.id, title: pr.title, source: pr.source, target: pr.target, intent: pr.intent });
  const [repoTar, diff, prJson] = await Promise.all([
    opts.agents.upload("repo.tar.gz", tar),
    opts.agents.upload("diff.patch", out.diff),
    opts.agents.upload("pr.json", intent),
  ]);
  return { fileIds: { "repo.tar.gz": repoTar, "diff.patch": diff, "pr.json": prJson }, changedPaths: out.changedPaths, config: out.config };
}

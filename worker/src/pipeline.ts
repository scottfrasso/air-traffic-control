import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { indexFork } from "./artifacts";
import { checkerFor, type RepoRef } from "./checker";

export interface PipelineParams {
  baseline: string;
  fork: string;
  sha: string;
}

/**
 * Per-push check pipeline. One instance per (fork, sha).
 *   1. index: diff the fork against its base on baseline (Artifacts binding only)
 *   2. apply: store touched files / symbols in the Coordinator, which recomputes overlaps and signals
 */
export class PushPipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  override async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { baseline, fork, sha } = event.payload;
    const coordinator = this.env.COORDINATOR.getByName(baseline);

    const index = await step.do("index fork vs base", { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }, () =>
      indexFork(this.env, baseline, fork, sha),
    );

    await step.do("apply index", () => coordinator.applyIndex(index));

    // Milestone 4: speculative merge + typecheck against every other active fork, in the Sandbox.
    const plan = await step.do("plan speculative merges", () => coordinator.checkPlan(fork, sha));
    if (!plan.current) return { fork, sha, skipped: "superseded by a newer push" };
    const slow: WorkflowStepConfig = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };

    if (plan.others.length === 0) {
      await step.do("typecheck fork alone", slow, async () => {
        // Tokens are minted inside the step so they never land in Workflow state.
        await coordinator.applySingle(await checkerFor(this.env, baseline, fork).run({ mode: "single", repo: await readRef(this.env, fork), baseline: await readRef(this.env, baseline) }));
      });
    }
    // All pairs in parallel (each in its own work dir in the same warm container).
    const statuses = await Promise.all(
      plan.others.map((other) =>
        step.do(`speculative merge with ${other}`, slow, async () => {
          const out = await checkerFor(this.env, baseline, [fork, other].sort().join("|")).run({
            mode: "pair",
            a: await readRef(this.env, fork),
            b: await readRef(this.env, other),
            baseline: await readRef(this.env, baseline),
          });
          return (await coordinator.applyPair(out)).status;
        }),
      ),
    );
    const results = Object.fromEntries(plan.others.map((o, i) => [o, statuses[i]]));
    return { fork, sha, files: index.files.length, diffLines: index.diffLines, merges: results };
  }
}

/** Short-lived read token + remote for a repo, for the checker container. */
async function readRef(env: Env, repo: string): Promise<RepoRef> {
  using handle = await env.ARTIFACTS.get(repo);
  const [token, info] = await Promise.all([handle.createToken("read", 900), handle.info()]);
  return { name: repo, remote: info.remote, token: token.plaintext };
}

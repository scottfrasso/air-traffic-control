import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { indexFork } from "./artifacts";
import { checkerFor, type RepoRef } from "./checker";

export interface PipelineParams {
  baseline: string;
  fork: string;
  sha: string;
  /** "recheck": main moved; only re-verify the PR merged onto the new main. "pairs": only re-run the pair checks in `others`. */
  kind?: "push" | "recheck" | "pairs";
  others?: string[];
}

/**
 * Per-push check pipeline. One instance per (fork, sha).
 *   1. index: diff the fork against its base on baseline (Artifacts binding only)
 *   2. apply: store touched files / symbols in the Coordinator, which recomputes overlaps and signals
 */
export class PushPipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  override async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { baseline, fork, sha, kind = "push", others = [] } = event.payload;
    const coordinator = this.env.COORDINATOR.getByName(baseline);
    const slow: WorkflowStepConfig = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };
    // Is this PR, merged onto the current main, green? (Tokens are minted inside the step so they never land in Workflow state.)
    const onMain = () =>
      step.do("check PR on current main", slow, async () => {
        await coordinator.applySingle(await checkerFor(this.env, baseline, fork).run({ mode: "single", repo: await readRef(this.env, fork), baseline: await readRef(this.env, baseline) }));
      });
    // All pairs in parallel (each in its own work dir in the same warm container).
    const pairs = async (list: string[]) => {
      const statuses = await Promise.all(
        list.map((other) =>
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
      return Object.fromEntries(list.map((o, i) => [o, statuses[i]]));
    };
    if (kind === "recheck") {
      await onMain();
      return { fork, sha, kind };
    }
    if (kind === "pairs") return { fork, sha, kind, merges: await pairs(others) };

    const index = await step.do("index fork vs base", { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }, () =>
      indexFork(this.env, baseline, fork, sha),
    );

    await step.do("apply index", () => coordinator.applyIndex(index));

    // Milestone 4: speculative merge + typecheck against every other active fork, in the Sandbox.
    const plan = await step.do("plan speculative merges", () => coordinator.checkPlan(fork, sha));
    if (!plan.current) return { fork, sha, skipped: "superseded by a newer push" };
    const mainCheck = onMain();
    const results = await pairs(plan.others);
    await mainCheck;
    return { fork, sha, files: index.files.length, diffLines: index.diffLines, merges: results };
  }
}

/** Short-lived read token + remote for a repo, for the checker container. */
async function readRef(env: Env, repo: string): Promise<RepoRef> {
  using handle = await env.ARTIFACTS.get(repo);
  const [token, info] = await Promise.all([handle.createToken("read", 900), handle.info()]);
  return { name: repo, remote: info.remote, token: token.plaintext };
}

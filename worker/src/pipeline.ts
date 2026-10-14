import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { indexFork } from "./artifacts";
import { checkerFor, type RepoRef } from "./checker";

export interface PipelineParams {
  baseline: string;
  fork: string;
  sha: string;
  /** "recheck": main moved; only re-verify the PR merged onto the new main. "pairs": only re-run the pair checks in `others`. */
  kind?: "push" | "recheck" | "pairs";
  /** "pairs": the other PRs and the heads they were queued at. */
  others?: Array<{ name: string; sha: string }>;
  /** The main when the run started, so a failure after main moved again is ignored (see applyPipelineFailure). */
  main?: string;
}

/**
 * Per-push check pipeline. One instance per (fork, sha).
 *   1. index: diff the fork against its base on baseline (Artifacts binding only)
 *   2. apply: store touched files / symbols in the Coordinator, which recomputes overlaps and signals
 */
export class PushPipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  override async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { baseline, fork, sha, kind = "push", others = [], main } = event.payload;
    const coordinator = this.env.COORDINATOR.getByName(baseline);
    const slow: WorkflowStepConfig = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };
    // Is this PR, merged onto the current main, green? (Tokens are minted inside the step so they never land in Workflow state.)
    const onMain = () =>
      step.do("check PR on current main", slow, async () => {
        // A re-check after main moved runs where the landing ran: that container has the new main and builds its
        // TypeScript state once for every PR re-checked on it (issue #9: 3 builds per landing became 1).
        await coordinator.applySingle(await checkerFor(this.env, baseline, kind === "recheck" ? "land" : fork).run({ mode: "single", repo: await readRef(this.env, fork), baseline: await readRef(this.env, baseline) }));
      });
    // All pairs in parallel (each in its own work dir in the same warm container).
    // A pair that still fails after its retries is recorded as failed (never left outstanding, which would block landing).
    const pairs = async (list: Array<{ name: string; sha: string }>) => {
      const statuses = await Promise.all(
        list.map(async (other) => {
          try {
            return await step.do(`speculative merge with ${other.name}`, slow, async () => {
              // Same container as this push's own check (keyed by the pushing fork, issue #9): it has already fetched the
              // fork, built main's TypeScript state and cached the fork's "alone" result.
              const out = await checkerFor(this.env, baseline, fork).run({
                mode: "pair",
                a: await readRef(this.env, fork),
                b: await readRef(this.env, other.name),
                baseline: await readRef(this.env, baseline),
              });
              return (await coordinator.applyPair(out)).status;
            });
          } catch (err) {
            await step.do(`record failed merge with ${other.name}`, () => coordinator.applyPairFailure(fork, sha, other.name, other.sha, (err as Error).message));
            return "error";
          }
        }),
      );
      return Object.fromEntries(list.map((o, i) => [o.name, statuses[i]]));
    };
    if (kind === "pairs") return { fork, sha, kind, merges: await pairs(others) }; // each pair records its own failure

    const check = async () => {
      if (kind === "recheck") {
        await onMain();
        return { fork, sha, kind };
      }
      const index = await step.do("index fork vs base", { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }, () =>
        indexFork(this.env, baseline, fork, sha),
      );

      await step.do("apply index", () => coordinator.applyIndex(index));

      // Milestone 4: speculative merge + typecheck against every other active fork, in the Sandbox.
      const plan = await step.do("plan speculative merges", () => coordinator.checkPlan(fork, sha));
      if (!plan.current) return { fork, sha, skipped: "superseded by a newer push" };
      // Wait for both before deciding: a failure in one must not be recorded while the other is still running.
      const [mainCheck, merges] = await Promise.allSettled([onMain(), pairs(plan.others)]);
      if (mainCheck.status === "rejected") throw mainCheck.reason;
      if (merges.status === "rejected") throw merges.reason;
      const results = merges.value;
      return { fork, sha, files: index.files.length, diffLines: index.diffLines, merges: results };
    };
    try {
      return await check();
    } catch (err) {
      // Out of step retries (cold start, "checker produced no result"): say so, so the PR isn't pending forever (issue #2).
      const error = (err as Error).message;
      await step.do("record pipeline failure", () => coordinator.applyPipelineFailure(fork, sha, error, main));
      return { fork, sha, kind, failed: error.slice(0, 300) };
    }
  }
}

/** Short-lived read token + remote for a repo, for the checker container. */
async function readRef(env: Env, repo: string): Promise<RepoRef> {
  using handle = await env.ARTIFACTS.get(repo);
  const [token, info] = await Promise.all([handle.createToken("read", 900), handle.info()]);
  return { name: repo, remote: info.remote, token: token.plaintext };
}

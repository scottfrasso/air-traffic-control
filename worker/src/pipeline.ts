import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { indexFork } from "./artifacts";

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

    return { fork, sha, files: index.files.length, diffLines: index.diffLines };
  }
}

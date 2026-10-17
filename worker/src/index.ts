import type { ArtifactsEvent } from "./events";
import { consumeBatch } from "./queue";
import { handle } from "./review/entry";
import { routeReviewPush } from "./review/routing";

export { Checker } from "./checker";
export { RepoStore } from "./review/store";
export { Directory } from "./review/directory";
export { ReviewRun } from "./review/workflow";
// The ATC subsystem's classes stay exported until their bindings are removed (Task 13).
export { Coordinator } from "./coordinator";
export { PushPipeline } from "./pipeline";

export default {
  fetch(request, env, ctx): Promise<Response> {
    return handle(request, env, ctx);
  },

  /** Artifacts push events (every branch) → the repo's store. Each message is acked or retried on its own (issue #7). */
  async queue(batch, env): Promise<void> {
    await consumeBatch(batch.messages, (event) => routeReviewPush(env, event));
  },
} satisfies ExportedHandler<Env, ArtifactsEvent>;

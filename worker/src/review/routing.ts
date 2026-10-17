import { isPushed, type ArtifactsEvent } from "../events";
import type { RepoStore } from "./store";

/** A push to any branch of a repo (Artifacts event via the queue) → that repo's store, which moves its PRs. */
export async function routeReviewPush(env: { REPOS: DurableObjectNamespace<RepoStore> }, event: ArtifactsEvent): Promise<void> {
  if (!isPushed(event) || !event.payload.ref.startsWith("refs/heads/")) return;
  const repo = event.source.repoName;
  const store = env.REPOS.getByName(repo);
  await store.init(repo);
  await store.onPush(event.payload.ref, event.payload.after);
}

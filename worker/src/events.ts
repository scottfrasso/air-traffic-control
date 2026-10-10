/** `cf.artifacts.repo.pushed`, per https://developers.cloudflare.com/artifacts/guides/event-subscriptions/ */
export interface PushedEvent {
  type: "cf.artifacts.repo.pushed";
  source: { type: "artifacts.repo"; namespace: string; repoName: string };
  payload: {
    ref: string;
    before: string;
    after: string;
    commits: Array<{
      id: string;
      message: string;
      messageTruncated: boolean;
      timestamp: string;
      author: { name: string; email: string };
      committer: { name: string; email: string };
      parents: string[];
    }>;
    totalCommitsCount: number;
    commitsTruncated: boolean;
  };
  metadata: { accountId: string; eventSubscriptionId: string; eventSchemaVersion: number; eventTimestamp: string };
}

/** Any Artifacts event; we only act on `pushed` but log everything we receive. */
export type ArtifactsEvent = PushedEvent | { type: string; source: { namespace: string; repoName: string }; payload: unknown };

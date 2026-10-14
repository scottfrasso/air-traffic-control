# ADR-0002: Push events reach the coordinator through per-fork Queue event subscriptions

- Status: Accepted (unverified against live service, blocked on Workers Paid)
- Date: 2026-10-10

## Context
Artifacts emits `cf.artifacts.repo.pushed` only on the **repo-level** source `artifacts.repo`.
That source needs `namespace` + `repo_name`. The account-level `artifacts` source only emits
created/deleted/forked/imported. Events are delivered through Queues event subscriptions.
Source: https://developers.cloudflare.com/artifacts/guides/event-subscriptions/

Wrangler 4.149 creates these with
`wrangler queues subscription create <queue> --source artifacts.repo --source-namespace <ns> --source-repo-name <repo> --events pushed`,
which calls `POST /accounts/{id}/event_subscriptions/subscriptions` with:
```json
{ "name": "...", "enabled": true,
  "source": { "type": "artifacts.repo", "namespace": "<ns>", "repo_name": "<repo>" },
  "destination": { "type": "queues.queue", "queue_id": "<queue uuid>" },
  "events": ["pushed"] }
```

## Decision
- One queue, `agentmesh-push-events`, consumed by the main Worker.
- When the Worker creates a fork, it creates a `pushed` subscription for that fork through the REST API.
  This uses a narrowly scoped API token stored as a Worker secret. It deletes the subscription
  when the fork lands or is abandoned. The baseline repo also gets a subscription, so external pushes to it are seen.
- The queue consumer forwards each event to the repo's Coordinator DO. Each message is acked or retried on its own
  (`worker/src/queue.ts`, issue #7, 2026-10-14): a failure is retried with a back-off (5 s doubling, capped at 60 s)
  and logged, and it doesn't block or re-run the rest of the batch. After `max_retries` (3) a message goes to the
  dead-letter queue `agentmesh-push-events-dlq` (nothing consumes it; inspect it with `wrangler queues`). Retries are
  safe because `onPush` de-duplicates by (repo, sha), and the reconcile alarm (ADR-0006) still catches a lost push.

## Consequences
- The Worker needs a Cloudflare API token secret (Event Subscriptions edit). This is the only reason it holds one.
- Event latency is set by Queues batching. We set `max_batch_timeout` low.

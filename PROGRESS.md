# PROGRESS

## Blocked

Nothing. Workers Paid is active (2026-10-10), and the token reaches Artifacts, Containers, Queues, Workflows and Event Subscriptions.
Note that the API token expires 2026-10-15 21:59 UTC.

## Done

- **Milestone 1: Spike** ✅ (verified against real Artifacts; findings in DECISIONS.md)
  - Sample TS repo `sample-repo/` (shop-core: money → pricing → cart → index, `tsc --noEmit`).
  - Imported into Artifacts (create + `git push`), forked twice, pushed to a fork with plain git.
  - Push event received in the deployed Worker (Queue consumer → Coordinator DO event log), about 4 s latency.
  - Found that new subscriptions take 30–60 s to activate → ADR-0006 reconcile fallback.
  - Worker locked behind a shared API key (ADR-0005), verified 401/200.

## Next

- Milestone 2: in-flight index (fork registry, diff vs base, exported symbols, dashboard).

## Stubbed / cut / known gaps

- One shared API key; agent identity is not authenticated (ADR-0005).
- Spike resources (`spike-base*` repos, their subscriptions) still exist in namespace `agentmesh`. They'll be deleted once M2 has its own setup script.

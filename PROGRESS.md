# PROGRESS

## Blocked (soft; not stopping work)

- **Worker can't create push subscriptions:** the main token appears IP-restricted. A browser-bot prompt for a Queues-only token is in
  `handover/01-create-subscriptions-token.md`. Until then, pushes are detected by the reconcile fallback (about 5 s).

Previously: nothing. Workers Paid is active (2026-10-10), and the token reaches Artifacts, Containers, Queues, Workflows and Event Subscriptions.
Note that the API token expires 2026-10-15 21:59 UTC.

## Done

- **Milestone 1: Spike** ✅ (verified against real Artifacts; findings in DECISIONS.md)
  - Sample TS repo `sample-repo/` (shop-core: money → pricing → cart → index, `tsc --noEmit`).
  - Imported into Artifacts (create + `git push`), forked twice, pushed to a fork with plain git.
  - Push event received in the deployed Worker (Queue consumer → Coordinator DO event log), about 4 s latency.
  - Found that new subscriptions take 30–60 s to activate → ADR-0006 reconcile fallback.
  - Worker locked behind a shared API key (ADR-0005), verified 401/200.

- **Milestone 2: In-flight index** ✅ (`demo/src/checks/m2-index.ts` passes against deployed resources)
  - `POST /api/repos/:baseline/forks` forks through the Artifacts binding, mints a fork write token and a baseline read token,
    and creates the fork's push subscription.
  - Push (event or reconcile) → `PushPipeline` Workflow → tree diff vs merge base through the binding → Coordinator stores
    touched files, exported-symbol deltas and imports → file and symbol overlaps.
  - Dashboard at `/r/<baseline>` (strip-bay design, polls every second).
  - Indexing completes about 10 s after push.

- **Milestone 3: Intent and early signals** ✅ (`demo/src/checks/m3-signals.ts` passes; agent B runs entirely over MCP)
  - `declare_intent` returns overlaps with other forks' changes, uses and intents, and notifies those forks.
  - `get_signals`: signature changes reach forks that import, edit, or plan to touch the symbol; the changer learns its dependents;
    file overlaps; intent overlaps. Signals refresh in place and resolve when they stop holding.
  - MCP server at `/mcp` (stateless), with tools `start_work`, `declare_intent`, `get_signals`.

## Next

- Milestone 4: speculative merges + typecheck in a Sandbox container, run from the Workflow.

## Stubbed / cut / known gaps

- One shared API key; agent identity is not authenticated (ADR-0005).
- Spike resources (`spike-base*` repos, their subscriptions) still exist in namespace `agentmesh`. They'll be deleted once M2 has its own setup script.

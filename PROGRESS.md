# PROGRESS

## Blocked

Nothing. The Worker subscription token was added 2026-10-10, and per-fork push subscriptions are verified working.

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

- **Milestone 4: Speculative merges** ✅ (`demo/src/checks/m4-speculative.ts` passes)
  - Plain git merges A and B cleanly; the container finds `src/checkout.ts:6 TS2345` only in the merge.
  - Both agents get a `semantic_conflict` signal naming `applyDiscount` and the other fork about 21 s after push, before any landing.
- Repo: private GitHub repo `scottfrasso/air-traffic-control`, MIT license, TruffleHog secret scan on every PR.

## Next

- Milestone 5: `request_land` landing gate + arbitration + rebase-required.
- Then: `demo/run.sh`, the 8-bit runway dashboard (see memory/user request), README, DEMO_SCRIPT.

## Stubbed / cut / known gaps

- One shared API key; agent identity is not authenticated (ADR-0005).
- `demo/src/teardown.ts [--keep <baseline>]` cleans up old runs (repos, forks, subscriptions).

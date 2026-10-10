# ADR-0009: Stateless MCP server; a separate, unrestricted-IP token for subscriptions

- Status: Accepted
- Date: 2026-10-10

## MCP
`McpAgent` is deprecated in agents 0.28. `/mcp` uses `createMcpHandler` from `agents/mcp/server` with
`@modelcontextprotocol/server@2.0.0` (pinned to match agents' exact peer dependency). A fresh `McpServer` is created per request, and all
state lives in the Coordinator DO. Tools: `start_work`, `declare_intent`, `get_signals` (plus `request_land` in M5).
The same bearer key as the HTTP API (ADR-0005) is required.

## Subscription token
From inside the Worker, the project's main token passed `/user/tokens/verify` but returned 401 on every account-scoped
route, while the same calls succeeded from the developer machine. That's consistent with a Client IP Address Filtering rule.
Decision: the Worker uses its own token, `CLOUDFLARE_AGENTMESH_WORKER_API_KEY` in `.env` → Worker secret `CF_API_TOKEN`,
with **only Queues: Edit** and no IP filter (`handover/01-create-subscriptions-token.md`). Verified 2026-10-10: forks get
subscriptions (`subscription.created`).

Subscription creation lives in the stateless Worker (`src/forks.ts`). The DO only records the id, so the Coordinator makes no
Cloudflare API calls.

## Gotcha: alarm-kept DOs run stale code
A Coordinator whose reconcile alarm fires every 5 s never goes idle, so it **kept running the old code and old secret
values across `wrangler deploy`**. The RPC error `does not implement the method "attachSubscription"` exposed this.
Mitigations:
- The reconcile alarm stops after 10 minutes without activity (`RECONCILE_IDLE_MS`), and the next API call restarts it.
- `demo/src/teardown.ts` abandons forks, which stops alarms, and deletes old repos and subscriptions.
- Each demo run uses a fresh baseline, so it gets a fresh DO on current code (ADR-0008).

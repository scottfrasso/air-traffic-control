# ADR-0009: Stateless MCP server; a separate, unrestricted-IP token for subscriptions

- Status: Accepted
- Date: 2026-10-10

## MCP
`McpAgent` is deprecated in agents 0.28. `/mcp` uses `createMcpHandler` from `agents/mcp/server` with
`@modelcontextprotocol/server@2.0.0` (pinned to match agents' exact peer dependency). A fresh `McpServer` is created per request, and all
state lives in the Coordinator DO. Tools: `start_work`, `declare_intent`, `get_signals` (plus `request_land` in M5).
The same bearer key as the HTTP API (ADR-0005) is required.

## Subscription token
From inside the Worker, the project's main token passes `/user/tokens/verify` but returns 401 on every account-scoped
route, while the same calls succeed from the developer machine. That's consistent with a Client IP Address Filtering
rule on the token. Decision: the Worker gets its own token with **only Queues: Edit** and no IP filter
(`handover/01-create-subscriptions-token.md`). Until then, subscription creation fails, which is logged as `subscription.failed`,
and the ADR-0006 reconcile path detects pushes (about 5 s).

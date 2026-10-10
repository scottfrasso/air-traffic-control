# ADR-0005: One shared API key guards every route except /health

- Status: Accepted
- Date: 2026-10-10

## Context
`agentmesh.scottfrasso.workers.dev` is public. Upcoming routes mint Artifacts **write** tokens
(fork creation) and merge into the baseline (`request_land`). Users, orgs and permissions are out of scope (prompt.md).

## Decision
- A single random key, `AGENTMESH_API_KEY`, is stored as a Worker secret and in local `.env` (gitignored).
- `/api/*`, `/mcp` and the dashboard data endpoints require `Authorization: Bearer <key>`. The dashboard may
  pass `?key=` because EventSource and WebSocket can't set headers. Comparison is constant-time
  (`crypto.subtle.timingSafeEqual`).
- `/health` and the static dashboard HTML shell are public. The shell holds no data.
- Rotation: `wrangler secret put AGENTMESH_API_KEY` plus updating `.env`.

## Consequences
- Every agent shares one identity. Agents identify themselves by fork name, which isn't authenticated.
  That's acceptable for a prototype and listed in PROGRESS.md as a known gap.
- Artifacts repo tokens handed to agents are scoped to their own fork, plus read access to the baseline.

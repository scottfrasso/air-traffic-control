# DECISIONS

Architecture decisions are recorded as ADRs in [`docs/adr/`](docs/adr/). This file is the index plus
the raw spike findings (milestone 1).

## ADR index

| # | Title | Status |
| --- | --- | --- |
| [0001](docs/adr/0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](docs/adr/0002-push-events-via-per-fork-queue-subscriptions.md) | Push events via per-fork Queue event subscriptions | Accepted |
| [0003](docs/adr/0003-local-artifacts-stand-in.md) | Local Artifacts stand-in | Superseded by 0004 |
| [0004](docs/adr/0004-real-artifacts-only.md) | Real Artifacts only, no simulator | Accepted |
| [0005](docs/adr/0005-shared-api-key.md) | Shared API key on all routes | Accepted |
| [0006](docs/adr/0006-reconcile-fork-heads.md) | Push events + head-reconcile fallback | Accepted |
| [0007](docs/adr/0007-lightweight-symbol-extraction.md) | Scan-based symbol extraction; tsc is the source of truth | Accepted |
| [0008](docs/adr/0008-baseline-per-run-and-dashboard-polling.md) | Fresh baseline per run; dashboard polls | Accepted |
| [0009](docs/adr/0009-stateless-mcp-and-token-split.md) | Stateless MCP; separate subscription token | Accepted |
| [0010](docs/adr/0010-checker-container.md) | Speculative merges in a container-backed Checker DO | Accepted |
| [0011](docs/adr/0011-landing-gate.md) | Landing gate, arbitration, full-ancestry merge base | Partly superseded by 0015 |
| [0012](docs/adr/0012-runway-dashboard.md) | 8-bit runway dashboard (now side view + ATC sequence) | Accepted |
| [0013](docs/adr/0013-incremental-checks.md) | Compute main once, check only deltas (repo cache, tree-hash results, incremental tsc) | Accepted |
| [0014](docs/adr/0014-live-push-replay-webhooks.md) | Live WebSocket push, recorded replay, outbound webhooks, real agents | Accepted |
| [0015](docs/adr/0015-merge-queue-landing.md) | Merge-queue landing; only real conflicts go around | Accepted |
| [0018](docs/adr/0018-landing-reliability.md) | Land only what was checked: pinned heads, owned lock, current-head pair coverage | Accepted |
| [0019](docs/adr/0019-flight-log-and-savings.md) | Flight log as a git note (refs/notes/atc); savings from the event log | Accepted |

## Milestone 1 spike findings (real Artifacts, 2026-10-10)

API references: `docs/cf-api-notes.md` (Workers/DO/Workflows/Containers/MCP/Queues) and the generated
`worker/worker-configuration.d.ts` (exact Artifacts binding types).

- **Namespace** must be created first: `POST /accounts/{id}/artifacts/namespaces {"namespace":"agentmesh"}`.
- **Create repo** (REST): returns `remote` = `https://<account>.artifacts.cloudflare.net/git/agentmesh/<repo>.git` plus a write token.
- **Import:** `import()` only takes a public HTTPS git URL. Our sample repo isn't public, so we "import" by creating an
  empty repo and `git push`ing the sample content with a normal git client. That took 0.75 s.
- **Fork** (REST `POST .../repos/:name/fork`) is synchronous (about 2 s) and returns `objects`, `remote` and a token.
  `info().source` = `"artifacts:agentmesh/<parent>"`.
- **Git auth:** `git -c http.extraHeader="Authorization: Bearer <token>"` works for clone and push.
- **`log()`** returns `{hash, treeHash, message, author, committer, parents, authoredAt, committedAt}`, newest first, first-parent.
- **Push events:** `wrangler queues subscription create <queue> --source artifacts.repo --source-namespace agentmesh --source-repo-name <repo> --events pushed`.
  The delivered message matches the docs exactly (`source.repoName` camelCase, `payload.before/after/ref/commits`).
- **Latency:** 0.7 s push→event, about 4 s push→DO on a warm subscription.
- **⚠ Activation delay:** a new subscription silently drops pushes for its first 30–60 s (see ADR-0006).
- **Artifacts has no local simulator** (`"DO-NOT-USE-this-resource-will-never-have-a-local-simulator"` in wrangler).
- **Sandbox SDK 1.0** removed the `Sandbox` class. We'll use a DO with `ctx.container` and our own Dockerfile.
- **MCP:** `McpAgent` is deprecated. We'll use the stateless `createMcpHandler` (agents 0.28 + `@modelcontextprotocol/server@2.0.0`).
- **No namespace-wide push source:** `POST event_subscriptions` with `artifacts.repo` and no `repo_name` → `Validation error: Required at "source.repo_name"`.
  `--source artifacts` + `pushed` → `Unrecognized event types`. So it's one subscription per fork, created by the Worker.

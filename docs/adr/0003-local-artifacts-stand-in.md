# ADR-0003: Local Artifacts stand-in behind a `RepoHost` interface

- Status: Superseded by ADR-0004 (2026-10-10). The account was upgraded to Workers Paid, so we use real Artifacts.
- Date: 2026-10-10

## Context
Artifacts has no local simulator. Wrangler's source names it
`"DO-NOT-USE-this-resource-will-never-have-a-local-simulator"`, and in `wrangler dev` the binding
always reaches the remote service. The account is not yet on Workers Paid, so remote Artifacts is unavailable.

## Decision
- Worker code never calls `env.ARTIFACTS` directly. It goes through `RepoHost`,
  which mirrors the subset of the binding we use: `create`, `fork`, `createToken`, `log`, `readCommit`,
  `readTree`, `readBlob`, plus `remote`.
- `ArtifactsRepoHost` wraps the real binding.
- `HttpRepoHost` calls `devhost/`, a small TypeScript Node server. It stores bare repos on disk,
  serves them over git smart-HTTP (`git http-backend`) at `/git/<ns>/<repo>.git`, accepts
  `Authorization: Bearer <token>` like Artifacts, and emits push events in the exact
  `cf.artifacts.repo.pushed` JSON shape to the Worker's dev-only `/__dev/events` route.
  That route feeds the same handler as the queue consumer.
- `REPO_HOST=artifacts|devhost` in wrangler vars selects the implementation.

## Consequences
- The full demo runs locally today. Production differs only in the `RepoHost` and the event transport.
- The stand-in may diverge from real Artifacts behavior. Anything verified only against it is marked so in PROGRESS.md.

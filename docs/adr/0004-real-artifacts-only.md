# ADR-0004: Build and test against real Artifacts only. No local simulator.

- Status: Accepted
- Date: 2026-10-10
- Supersedes: ADR-0003

## Context
The account owner upgraded to Workers Paid ($5/mo) and asked to use the real service.
Artifacts has no local simulator, and in `wrangler dev` the binding reaches the remote service anyway.

## Decision
- All development and the acceptance demo run against real Artifacts in namespace `agentmesh`.
- Worker code uses `env.ARTIFACTS` directly through a thin `repos.ts` helper module. There's no pluggable `RepoHost` interface.
- Scripts outside the Worker (seeding, the demo) use the Artifacts REST API with `CLOUDFLARE_API_TOKEN`
  only for setup, and repo-scoped tokens for git. Agents get fork remotes and tokens from our Worker API.

## Consequences
- Every dev loop costs Artifacts operations. Free allowance is 10k ops/month, then $0.15 per 1k; the demo uses about 100.
- The test loop requires network access and a deployed Worker (queue events don't reach `wrangler dev`).

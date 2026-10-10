# ADR-0008: A fresh baseline repo per demo run; the dashboard polls

- Status: Accepted
- Date: 2026-10-10

## Decision
- Each demo/check run seeds a new baseline (`shop-<yymmddhhmmss>`, `m2-…`). Forks are `<baseline>--<agent>`.
  A Coordinator DO is addressed by baseline name, so every run starts with clean state and no reset endpoint.
  Old runs are cleaned up by a teardown script.
- The dashboard is a static page that polls `GET /api/repos/:baseline/state` once a second with the API key.
  We chose this over WebSockets or SSE because it's simpler, survives DO hibernation and deploys,
  and one-second freshness is enough for a demo.

## Consequences
- Artifacts storage grows by one tiny repo per run until teardown.

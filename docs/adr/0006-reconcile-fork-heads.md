# ADR-0006: Push events plus a head-reconcile fallback

- Status: Accepted
- Date: 2026-10-10

## Context
Spike measurements against real Artifacts (2026-10-10):
- On a warm subscription, push → `eventTimestamp` is about 0.7 s, and → our DO about 4 s (Queues, `max_batch_timeout: 0`).
- **A new `artifacts.repo` subscription takes 30–60 s to start delivering.** Pushes at +0 s, +15 s and +30 s after
  creating the subscription were silently dropped, while the push at +60 s was delivered. Each fork is a new repo,
  so it needs a new subscription, and an agent typically pushes within seconds of forking.

## Decision
- Push events stay the primary trigger (Queue consumer → Coordinator → Workflow).
- The Coordinator also **reconciles**: while any fork is active, a DO alarm every 5 s reads each fork's
  `main` head with `repo.log({ limit: 1 })`. A head that differs from the last processed sha
  is handled exactly like a push event, with `source = "reconcile"` in the event log.
- Pushes are de-duplicated by `(fork, sha)`, so an event and a reconcile never trigger work twice.
- The alarm stops when no forks are active, so idle cost is zero.

## Consequences
- Artifacts ops while active: about 12 per minute per fork. Negligible for the demo.
- The dashboard and event log show which path detected each push. That's useful in the video and honest about the beta limitation.

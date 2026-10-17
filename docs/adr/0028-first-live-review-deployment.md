# ADR-0028: First live deployment of the review pipeline

- Status: Accepted.
- Date: 2026-10-17.
- Amends ADR-0027 (models, budgets, reviewer overlap, identity bootstrap) and ADR-0025 (what `setup:cloudflare` deploys).

## Context
ADR-0027's pipeline was built and tested with fakes. Its first runs against real Claude Managed Agents found API
details the fakes had wrong, showed that three reviewers report the same bugs, and gave us real cost numbers. Cloudflare
Access wasn't set up yet, so nobody could sign in to create the personal token the end-to-end test needs.

## Decision
- **A separate Worker.** The review pipeline deploys as `agentmesh-review` with its own queues
  (`agentmesh-review-push-events` and its DLQ). The ATC Worker `agentmesh` and its data stay as they were: no
  Durable Object deletion migration, nothing to roll back. Both share the `agentmesh` Artifacts namespace; repos are
  told apart by name, and each repo's push subscription points at its own Worker's queue.
- **Models and budgets for cost.** Classifier on Claude Haiku 5.5; correctness, security, tests and verifier on Claude
  Sonnet 5.5 (was Sonnet and Opus). Default budgets 50 / 200 / 30 US cents per classifier / reviewer / verifier
  session (was 200 / 500 / 50); the caps a repo can raise them to are unchanged. On the sample PR, Haiku's triage named
  both planted bugs, so the cheap model is enough for routing.
- **Reviewer lanes, and one finding per bug.** Each reviewer's prompt names what isn't its job (security holes belong
  to security, missing tests to tests, the bugs themselves to correctness and security). The pipeline now waits for all
  reviewers, merges duplicates across them (`dedupeAcross`: same file, within 5 lines, most of the shorter
  description's words shared; kept with the reviewer whose lane it is, else the most severe), and only then verifies,
  so each bug costs one verifier session. Findings from one reviewer are never merged with each other; different bugs
  on one line stay apart. Because findings are now written after every reviewer is done, each reviewer checks after
  its session that the run is still current, so a cancelled run stops without waiting for the slowest one.
- **Temporary identity bootstrap.** Until Access is in front of the UI, `POST /api/admin/tokens {email}` with
  `Authorization: Bearer <ADMIN_SECRET>` (a Worker secret; unset turns it off) mints a personal token for that email.
  The secret is compared by digest. A minted token is an ordinary token (`via: "token"`), so ADR-0027's rule holds: it
  can't approve or resolve an important finding. The cost: until Access exists nobody can approve, so a PR that needs
  a person can't merge. Remove the endpoint once Access is set up.
- **Managed Agents details**, as seen live and now in the client (raw notes in `DECISIONS.md`): environments need
  `config.type: "cloud"`; `mount_path` is relative to `/mnt/session/uploads`; outputs appear in the session's file
  list 1–3 s after idle, so `poll` looks up to 4 times, 2 s apart, and takes only `downloadable` files (the mounted
  inputs are listed too); `GET /v1/agents` returns `model` as an object, so `setup:agents` compares by id.

## Consequences
- `pnpm e2e:review` passes live: both planted bugs found, verified and blocking; after a complete fix the follow-up is
  clean; merge waits for a person. About 4 minutes and $0.34 a run (14 sessions), down from $0.81 (33 sessions) before
  lanes and dedupe.
- Dedupe is a heuristic: in the last run one bug still came up twice (same file, different wording). Tune it on more
  PRs, with an eval set, before trusting it further; a model-based merge step is the alternative.
- The end-to-end test's fix commit now fixes everything the agents rightly flag on the sample (not only the two
  planted bugs); a reviewer that finds more real bugs than we planted is the point, not a test failure.

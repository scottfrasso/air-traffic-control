# ADR-0010: Speculative merges run in a container-backed `Checker` DO (Sandbox SDK 1.0 model)

- Status: Accepted
- Date: 2026-10-10

## Context
Milestone 4 needs real `git merge` + `tsc --noEmit` on every pair of active forks. Sandbox SDK 1.0 (2026-09-30)
removed the `Sandbox` class. The supported pattern is a Durable Object with `ctx.container` (`start`/`exec`) and your own image.

## Decision
- `worker/container/Dockerfile`: `node:24-trixie-slim` + git + `typescript@7.0.2`, plus `check.ts` (run natively by Node 24 type stripping).
- `check.ts` modes: `single` (typecheck one fork), `pair` (A alone, B alone, `git merge` B into A, typecheck the merge), and `land`
  (verify fork is current, typecheck, fast-forward baseline main). Input is passed in the `CHECK_INPUT` env var, and the output is one `@@RESULT {json}` line.
- One `Checker` DO per baseline (`checker-<baseline>`) keeps a warm `standard-1` container (10-minute inactivity timeout).
- `PushPipeline` adds steps after indexing: plan → `speculative merge with <fork>` per other active fork, or `typecheck fork alone`.
  Repo read tokens (15 min) are minted **inside** each step, so they never land in Workflow state.
- Verdict (`src/conflicts.ts`): if the merge is textually clean but has typecheck errors that neither fork has alone, that's a
  **semantic conflict**. The symbol is identified by matching the error line against either fork's breaking export changes.
  Both forks get a signal naming the symbol and the other fork. Textual conflicts produce `merge_conflict`.
  When the pair is clean again, the signals resolve.

## Consequences
- Measured: push → semantic-conflict signal about 21 s, including container cold start. A local container check takes about 6 s.
- `containers[].max_instances` is rejected for `durable_object` scheduling, so the config only uses `images` + `scheduling_policy`.

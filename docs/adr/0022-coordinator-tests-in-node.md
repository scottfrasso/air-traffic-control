# ADR-0022: Test the Coordinator Durable Object in plain Node, on node:sqlite

- Status: Accepted.
- Date: 2026-10-14. Issue #4, groundwork for #11.

## Context
Only pure helpers were tested. Bugs like #2 and #4 live in the Coordinator's glue: what it writes to SQLite and
which Workflows it starts. `@cloudflare/vitest-pool-workers` runs real workerd, but this Worker binds Artifacts (beta),
Containers and Workflows, which local workerd can't fully provide, and adding vitest is a second test runner.

## Decision
- `worker/test/harness/` runs the real `Coordinator` class in Node's test runner:
  - `register.mjs` maps `cloudflare:workers` to a stand-in (`DurableObject`, `WorkflowEntrypoint`).
  - `coordinator.ts` backs `ctx.storage.sql` with `node:sqlite` (the same SQLite dialect, so the schema and queries
    run unchanged) and fakes the bindings: Artifacts heads from a map, and `PUSH_PIPELINE.create` that records instances
    and throws Workflows' duplicate error (code 10405).
- `pnpm --dir worker test` loads the harness (`--experimental-sqlite` on Node 22).
- The harness also fakes the checker container (`CHECKER`, answered by `airport().checker`), so the land path runs for
  real: `requestLand` → the gate → the landing lock → `onLanded` (issue #11). `container/check.ts` itself is tested
  separately against temporary git repos (`worker/test/container.test.ts`: pairs, a textual conflict, the
  environment-failure rule, the lock, land onto main, a stale expected head, and a main conflict at land).
- `pnpm test` at the repo root runs every package's tests (`pnpm -r --if-present test`).

## Consequences
- Coordinator behaviour (meta, signals, the pipelines it starts) is now testable without deploying.
- It isn't workerd: input gates, storage limits and real binding errors aren't modelled. The deployed `./demo/run.sh`
  is still the end-to-end check.
- Tests reach private methods with a cast when they need to stage state (for example, emitting a signal).

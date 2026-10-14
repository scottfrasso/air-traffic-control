# ADR-0021: A PR's checks never stay pending: re-check on any main move, record failures, restart stuck runs

- Status: Accepted. Tightens ADR-0006 (reconcile), ADR-0015 (merge-queue landing) and ADR-0018.
- Date: 2026-10-14. Fixes issues #2 and #4.

## Context
A PR could sit in `check_status = pending` forever, with every `request_land` answering "retry":
- Main moved outside a landing ATC made (or ATC learned of it late, in `requestLand`). Only `baseline_head` was updated,
  so a single check already in flight finished on the old main, was dropped as stale, and nothing re-checked the PR.
- `requestLand` returned "checks still running" for any `pending` PR before it reached the "main moved: re-check" step.
- A Workflow that ran out of step retries reported nothing, and `startPipeline` logged every `create()` error as a duplicate.

## Decision
- **Any main move re-checks.** `baselineMoved` (from the baseline's push event, reconcile, or `requestLand` seeing a
  newer head) records the head and re-checks every open PR not already checked on it (`forksToRecheck`), including a
  PR whose push is still being indexed (its own check may have read the old main).
- **Who moves `baseline_head`** (issue #4): only `baselineMoved` (a push to main, reconcile, a land request) and
  `onLanded`, both through `setMainHead`, which bumps `main_epoch`. Main never moves backwards:
  - A push event for main (maybe a delayed queue retry, maybe out of order) carries no trusted head. It only triggers
    `syncMainHead`, which reads main from Artifacts. Reconcile and land requests read it the same way.
  - A read is dropped (`baseline.stale_read`) if `main_epoch` changed while it was in flight (a landing or another
    read moved main), because its answer may be older. The next reconcile reads again 5 s later, so a wrong answer
    can't stick. (A first attempt, "ignore any head already seen", could deadlock: an older head not yet seen would be
    taken and the real one then refused forever. Review of #31.)
  - A fork's push event is checked against the fork's live head too (`push.event_stale`), so a retried event can't
    move a PR back to an older commit (review of #33). If that read fails, `onPush` throws
    (`push.event_unverified`), so the queue redelivers the event with a back-off (review of #35).
  - Main isn't read while a landing holds the lock (`baseline.read_deferred`): the landing may already have pushed
    main, and `onLanded` records that head itself. Otherwise reconcile would take ATC's own landing for an outside push.
  - `applyIndex` never writes `baseline_head`: an index computed before a landing and applied after would move it
    backwards. An index clears a PR's go-around only if its base is the **current** main, not the main it saw.
- **Gate order** (`landGate`): an errored check first, then "push not processed", then "checked on an old main → start a
  re-check" (even if pending; a duplicate start is a no-op), then "pending → retry".
- **Failures are recorded.** `PushPipeline` catches a push/re-check that fails for good and calls
  `applyPipelineFailure`: `check_status = 'error'` with the reason, a `check_failed` signal, and STANDBY with
  "ATC couldn't run the checks (…)" in the sequence. `request_land` answers retry while ATC still retries, then
  `land_blocked` ("push again to retry"). Pair checks keep their own failure path (ADR-0018). A re-check carries the
  main it ran on (`main` param, push runs too); its failure is ignored once main has moved again, unless the push
  was never indexed. The push pipeline waits for its main check and its pair checks (`allSettled`) before it
  records a failure. Any later result for the head
  (`setCheck`) clears the PR's `check_failed` signal.
- **Stuck runs restart.** Table `check_runs(fork, sha, started_at, restarts)` records the latest push/re-check started.
  The reconcile alarm (`stuckCheck`) restarts a check that errored (after 30 s) or has had no result for 20 min
  (`CHECK_STUCK_MS`, longer than the longest healthy run: indexing plus 3 tries of up to 5 min on main): the full push pipeline if the push was never indexed, else a re-check. Each restart is a new
  instance id (`-r<n>`). After `CHECK_MAX_RESTARTS` (3) per head ATC gives up and marks it `error` (once); a new push
  resets it. A green/red result on an older main isn't a failure: it is re-checked without counting a restart.
  Go-around PRs are skipped (onLanded leaves them un-checked on purpose). Giving up on a push whose index never
  applied writes `error` even over a green re-check, since a re-check can't finish that PR's checks.
- **`started_at` only moves on a real start** (or a real start failure). A duplicate start leaves it alone: an agent
  polling `request_land` re-requests the same re-check every few seconds and must not keep a hung run "fresh".
- **Decide before awaiting.** `restartStuckChecks` and `recheckAll` write every decision (pending, `check_runs`) before
  the first `await`, then start each Workflow only if the PR still has the same head and is still pending: a result or
  push that arrives while `create()` is awaited isn't overwritten.
- **Duplicates vs failures.** Only Workflows' "instance already exists" (`10405` / `already exists`) is logged
  `pipeline.duplicate`; anything else is `pipeline.start_failed`. Verified on the deployed Worker: a demo run's three
  duplicate starts were all logged as `pipeline.duplicate`. A failed start still records `check_runs`, so the alarm tries again.

## Consequences
- A run that fails is visible within seconds (`error`). One that hangs silently is restarted after 20 min.
- Restarts can overlap a slow but healthy run: duplicate work, and the first result to arrive wins (`setCheck` only
  accepts results for the current head; `applySingle` drops ones for an old main).
- `check_runs.restarts` is per head, not per main: a PR that used up its restarts stays `error` across main moves
  until it is pushed again.
- Instance ids stay under Workflows' 100-character limit with the suffix intact: the longest fork name is
  63 (baseline) + `--pr` + digits, so `<fork>-<sha12>-m<main10>-r<n>` is at most about 98.
- The alarm pauses after 10 min without activity, except while a PR's checks are pending or errored and may still be
  restarted (`checksAwaitingRestart`, which skips go-arounds exactly as `restartStuckChecks` does). That means pending
  at any restart count (after the last restart, the final give-up still has to fire), or errored with retries left.
  Bounded by the restart cap.
- Every push event now costs one extra Artifacts head read.

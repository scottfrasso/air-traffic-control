# ADR-0018: Land only what was checked: pinned heads, an owned lock, and current-head pair coverage

- Status: Accepted. Tightens ADR-0011 (landing gate) and ADR-0015 (merge-queue landing).
- Date: 2026-10-11, updated 2026-10-14. Fixes issues #1, #3, #5 (code review of `8b81097`); PR #22, and the #5 follow-up.

## Context
Three gaps let ATC land a commit it never fully checked: the land step fetched the fork's *current* head rather than the
one ATC checked (#1); the landing lock expired (120 s) before the land check could time out (240 s), and any landing
cleared it on exit (#3); and pair (speculative-merge) results for old heads were dropped without being redone, while
`requestLand` gated only on open conflict signals (#5).

## Decision
- **Pinned heads.** `land` gets `fork.expectedHead` (the head whose checks cleared it) as well as `baseline.expectedHead`.
  The container refuses with `retry` if either moved (`container/guard.ts`).
- **Owned lock.** Meta `landing` = `{token, at}`. TTL = checker timeout + 60 s (`LANDING_LOCK_MS`, from `CHECK_TIMEOUT_S`).
  Only the holder releases it.
- **Current-head pair coverage gates landing.** Every pair of active PRs with pushed changes needs a
  `pair_checks` row at both current heads before either is CLEARED (until then: CHECKING) or may land (`retry`).
  - A pair result is recorded **only if it is for both current heads** (`pairResultIsCurrent`). Older results would
    overwrite newer ones; results for a push ATC hasn't seen would count as checked without raising their conflicts.
  - Missing pairs are re-queued (`pair_queue`, `PushPipeline` kind `pairs`) from a dropped result, the reconcile alarm and
    a land request; a queued pair with no result after `PAIR_RETRY_MS` (= lock TTL) is assumed lost and re-queued.
    All due pairs are marked queued before the first `await`, so interleaved calls don't start one twice.
  - **Errors are retried, then liveness wins** (tightened 2026-10-14, issue #5). A pair check that still fails after its
    step retries is recorded as `error` with an attempt count (in `detail`, so no schema change). It **stays outstanding**
    (neither PR is CLEARED or lands) and the reconcile alarm runs it again `PAIR_ERROR_RETRY_MS` (30 s) later. Only after
    `PAIR_MAX_ATTEMPTS` (3) errors at the same heads does it count as checked, with a `check_failed` signal to both PRs,
    so a broken checker can't block landing forever; the typecheck on main at landing still applies. A new push starts
    the count again. `error` rows written before this change have no count and stay final.
    A failure never overwrites a real result at the same heads (a slow first run can outlive the retry window).
  - **One decision path** (2026-10-14). The gate order (`landGate`) and every pair decision (`pairPartners`,
    `pairResultRow`, `pairFailure`, `pairsToQueue`) are pure functions in `landing.ts`. The Coordinator only reads and
    writes its tables around them, and `landing.test.ts` drives the same functions, including two near-simultaneous pushes.
  - A PR whose push is still being indexed **does** hold its partners (their pair at its new head is unchecked).
    Its own push pipeline queues those pairs; if it's still unindexed after `PAIR_RETRY_MS` (`head_seen` table),
    its pairs are queued directly, so a stuck PR delays its partners by at most that long.

- **A land run that throws is a retry** (2026-10-15). If minting the tokens or the checker call itself throws (a
  container restarting right after a deploy, a network error), `request_land` logs `land.failed` and answers `retry`,
  instead of a 500 with nothing in the event log. If the push did reach main, the next request reads the new main
  and re-checks the PR, as for any outside move of main.

## Consequences
- Landing waits for pair checks: the scripted demo went from about 56 s to about 60–68 s.
- With many agents pushing often, every push briefly puts its partners back in CHECKING. Watch for starvation in the final.
- A persistently failing pair check (3 errors) lowers protection for that pair to the land-time typecheck on main.
  A transient one delays the pair's PRs by one check run plus 30 s per attempt. If the checker keeps timing out,
  each attempt is a step with 3 tries of up to 240 s, so both PRs can sit in CHECKING for up to about 37 min before the
  pair counts as checked (it was about 12.5 min before retries). Runs re-queued as lost while a slow one is still going
  also count toward the 3 attempts, so the cap counts failures rather than strictly one-after-another attempts.
- A slow but healthy pair check (up to 3 attempts × 5 min) can be re-queued while still running: duplicate work, no
  wrong result.
- Known limits, not addressed here: pair results don't record the main they ran on, so after a landing an old pair
  result still counts (each PR is re-checked alone on the new main, not in pairs); and a push that arrives after the
  land step fetched the fork is left behind when the PR is marked landed.

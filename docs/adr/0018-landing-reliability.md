# ADR-0018: Land only what was checked: pinned heads, an owned lock, and current-head pair coverage

- Status: Accepted. Tightens ADR-0011 (landing gate) and ADR-0015 (merge-queue landing).
- Date: 2026-10-11. Fixes issues #1, #3, #5 (code review of `8b81097`); PR #22.

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
- **Current-head pair coverage gates landing.** Every pair of active PRs with pushed, indexed changes needs a
  `pair_checks` row at both current heads before either is CLEARED (until then: CHECKING) or may land (`retry`).
  - A pair result is recorded **only if it is for both current heads** (`pairResultIsCurrent`). Older results would
    overwrite newer ones; results for a push ATC hasn't seen would count as checked without raising their conflicts.
  - Missing pairs are re-queued (`pair_queue`, `PushPipeline` kind `pairs`) from a dropped result, the reconcile alarm and
    a land request; a queued pair with no result after `PAIR_RETRY_MS` (= lock TTL) is assumed lost and re-queued.
  - **Liveness over completeness:** a pair check that still fails after its retries is recorded as `error` with a
    `check_failed` signal to both PRs, so it can't block landing forever; the typecheck on main at landing still applies.
    PRs whose latest push isn't indexed yet are left out of the gate, so one stuck PR can't block its partners.

## Consequences
- Landing waits for pair checks: the scripted demo went from about 56 s to about 60–68 s.
- With many agents pushing often, every push briefly puts its partners back in CHECKING. Watch for starvation in the final.
- A persistently failing pair check lowers protection for that pair to the land-time typecheck on main.

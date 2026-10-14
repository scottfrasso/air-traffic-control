# ADR-0024: Bounded Coordinator storage, and columns instead of parsed strings

- Status: Accepted.
- Date: 2026-10-14. Issue #10.

## Context
`event_log`, `snapshots` and `signals` grew forever. A PR that didn't fit on main was marked by an `"on main: "`
prefix in `check_detail`, which `atc.ts` and the landing gate parsed back out.

## Decision
- **Pruning** runs in the reconcile alarm: keep the newest `KEEP_EVENTS` (20,000) events and `KEEP_SNAPSHOTS`
  (5,000) snapshots, and delete resolved signals older than a week for PRs no longer in flight (their story is in the
  flight log). A 5-PR demo run writes about 600 events and 40 snapshots, so demo runs are never touched.
- **Never pruned:** the baselines in `PUBLIC_REPLAY_BASELINES` (ADR-0020) and `booking-261010213346` (the run the
  submitted video shows), so their replays stay whole (`keptBaselines`).
- **`forks.check_main_conflict`** (0/1) replaces the prefix. New columns go in `COLUMNS` (`schema.ts`): the constructor
  adds any that a Durable Object's table lacks (`ALTER TABLE … ADD COLUMN`), so existing DOs migrate in place.
  `mainConflict()` still reads the old prefix for rows written before the column.

## Consequences
- A very long-lived baseline's replay starts at its oldest kept snapshot, not at the beginning.
- Savings for such a baseline count only the kept events.

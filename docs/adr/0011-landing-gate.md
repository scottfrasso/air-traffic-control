# ADR-0011: Landing gate, arbitration and rebase-required

- Status: Accepted
- Date: 2026-10-10

## Decision
`request_land(fork)` (HTTP `POST /api/repos/:b/land` and the MCP tool):
1. Reads the fork's **live head** from Artifacts first. If there's an unseen push, it ingests it and answers `retry`
   (agents push and immediately ask to land).
2. If checks for the head are still running, it answers `retry`. This comes before the "current" test, because a fork's base is only
   known once its push is indexed.
3. **Current**: the fork's merge base equals baseline main. Otherwise it denies with a `rebase_required` signal.
4. **Green**: the fork typechecks alone at its head (Checker `single` or `pair` result).
5. **Arbitration** against forks with an open semantic or textual conflict signal: closest to landing wins, ranked by
   (requested landing) > (current) > (green). Ties go to the smaller diff (`src/landing.ts`, unit tested).
6. **Land**: the Checker container verifies baseline hasn't moved (`expectedHead`), checks that the fork contains it
   (`merge-base --is-ancestor`), typechecks, and **fast-forwards** baseline main with a 10-minute write token.
7. After landing, every other active fork gets `rebase_required`. Conflicting forks get the earlier finding and the symbol.
   The winner's push subscription is deleted.

## Merge base
Artifacts `log()` follows first parents only. After an agent merges baseline into its fork, the landed commit is
reachable only through the merge's second parent. `indexFork` walks the full ancestry instead: first-parent chunks via `log()`,
queueing the other parents, up to 500 commits. The merge base is the newest commit common to fork and baseline.

## Consequences
- Landing is fast-forward only, so baseline history keeps agents' merge commits. That's simple, and it's honest about how B rebased.
- One landing at a time per baseline (a `landing` lock in Coordinator meta, with a 2-minute safety expiry).

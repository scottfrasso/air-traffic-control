# ADR-0026: Competing attempts at one task: compare, STAND DOWN, pick

- Status: Accepted.
- Date: 2026-10-15. Issue #19.

## Context
Two agents are often given the same task, on purpose (best of N) or by accident. ATC already arbitrated PRs that
*conflict* (ADR-0011: closest to landing wins), but it didn't *compare* two attempts at the same thing. Both would land
if they didn't conflict, which ships the task twice.

## Decision
- **Same task only when the agents say so.** `declare_intent` (MCP and `POST /intents`) takes an optional `task`: a
  ticket id, or the id of the prompt an orchestrator handed out. It is stored on the intent (`intents.task`, trimmed and
  lower-cased) and a PR's task is the one its **latest** intent names. A later `declare_intent` without `task` keeps the
  PR's task (re-planning mustn't silently leave it, or the task could ship twice); `""` (or `null` over HTTP) clears it.
  `declare_intent` answers `sameTask`: the other PRs already on it.
  - The design on the issue also had a fallback (≥ 70 % overlap of declared files and symbols). It was dropped: two
    different tasks often touch the same files, and a false match would tell real work to stand down. An explicit key
    can't be wrong that way.
- **Compare once all attempts are checked.** While any attempt with pushed changes is still being checked (not yet
  green or red at its head on current main with its pair checks in, or errored with no retries left, even if its push
  was never indexed), a green attempt **waits** (STANDBY,
  `request_land` says retry) so an attempt that is merely slower to check doesn't lose. An attempt with nothing pushed
  doesn't count, and one sent around (GO AROUND) counts as decided and not green: ATC doesn't re-check it until it
  pushes, so waiting for it could take forever. A checker error ATC will still retry is not decided: a passing
  error mustn't lose the comparison.
- **Ranking** (`compareAttempts`, pure, in `attempts.ts`), the first step that differs decides and is the reason:
  1. green on current main (pairs in, not sent around);
  2. fewer open conflicts with other in-flight PRs (not counting the other attempts);
  3. fewer breaking changes to exported symbols (signature changed or removed);
  4. fewer exported symbols changed;
  5. fewer files touched;
  6. smaller diff;
  7. opened first (then by name, so the order is total).
  Steps 3 and 4 are the "blast radius". The issue's design weighted symbols by how many files use them; the index
  only records imports of files that PRs touch, not of all of main, so the weight isn't known and isn't faked.
- **STAND DOWN.** The best attempt ships if it is green (if none is green, nobody is told anything: each must fix
  itself). Each other attempt gets the new clearance `stand_down` with the reason ("Same task (free-shipping) as PR2,
  which ships: smaller blast radius (0 vs 1 breaking changes to exported symbols)."), a `stand_down` signal naming the
  winner (one per head, winner and reason; resolved when it no longer holds), and `request_land` refuses it.
  It comes after the PR's own checks in the sequence and the gate: a red attempt hears that it fails typecheck first.
  An attempt that stands down is never "ahead" of a rival in HOLD or the gate (it won't land), as for REVIEW.
- **After the winner lands**, the attempts that were in flight stand down **for good** ("PR2 already landed this
  task …"), shown even over GO AROUND, since rebasing changes nothing. The landing sends them neither a go-around nor
  "stay in line", and doesn't re-check them; they get a `stand_down` signal. Only a landing after the PR was opened
  counts, so a task key reused later (a follow-up on the same ticket) isn't blocked by an old landing.
  The winner's CLEARED reason says "Chosen over PR1 (same task)" when the loser conflicts with it. To keep a loser's work (it adds something), the agent declares an
  intent with a new task and pushes; then it is an ordinary PR again.
- **A person can override:** `POST /choose {fork, by}` or the dashboard's PICK button on a STAND DOWN row (with a
  key, never on the public replay). Table `task_choices(task, winner, by, at)` keeps the latest pick per task. The
  chosen PR still passes every other check. Refused (409) for a PR with no task, the only attempt, a task that has
  already landed, or during a landing. When the pick differs from ATC's ranking the reason says so ("picked by … over
  ATC's ranking (which preferred PR2: …)"); when it agrees, ATC's reason is kept with "confirmed by …".
- **Flight log:** the winner's note gets `ATC-Chosen-Over: PR1 (<reason>)` (up to three). `stand_down` is a story
  signal, so a former loser that lands later under a new task shows that it once stood down.

## Consequences
- Best-of-N runs need nothing but a shared `task`: ATC picks and says why; nothing ships twice.
- A green attempt can wait for its rival's checks (bounded: checks always end, ADR-0021).
- Identity is not enforced for `choose`, as for reviews (ADR-0005): `by` is a label.
- A loser that keeps pushing makes the winner wait again for each push's checks (each wait is bounded). Not
  prevented: a later push may make it the better attempt, which is the point of comparing.
- With no intent naming a task (the default), nothing about attempts is computed: one indexed `LIMIT 1` query.
- The verdicts are recomputed from state on every read; the stand-down signals are synced when state is flushed
  (and on a refused landing or a pick), so they can lag the clearance by the 120 ms flush delay.
- `./demo/run.sh --attempts [--browser]` runs it end to end: two attempts, STAND DOWN, a pick (in a real browser with
  `--browser`), the landing and the git note.

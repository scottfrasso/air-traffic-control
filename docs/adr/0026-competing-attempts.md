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
  `declare_intent` answers `sameTask` (the other PRs already on it) and `landedBy` (PRs that already landed it), so a
  late duplicate learns before writing code that the task has shipped; ATC doesn't block it (see below).
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
  - **Except ATC's own pick.** Table `task_leaders` remembers which attempt ATC chose last per task. If an unrelated
    landing sends *that* one around, the others wait for it for up to `LEADER_WAIT_MS` (= `CHECK_STUCK_MS`, 20 min)
    from when it was sent around, so a routine rebase doesn't hand the task to the attempt ATC ranked worse. After
    that it counts as not green like any other go-around.
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
- **A quiet winner hands over** (2026-10-15). The attempt that ships (ATC's pick or a person's) must show signs of
  life: a push, a `request_land`, a `declare_intent`, or its agent polling its own `get_clearance` or `get_signals`
  (table `fork_activity`). Polls count so that an agent told to HOLD, or waiting, is alive while it obeys; only an
  agent that has really stopped goes quiet. If it shows none for `stallSeconds` (default 15 min, per baseline:
  `POST /settings {"stallSeconds": n}`, 10 s to a day), ATC sets it aside and compares the rest again, so an agent
  that stopped can't stall the others. The clock starts at the latest of: its last sign of life, when it became the
  one to ship, and when its current head's checks first finished (`fork_checked`, once per head: check time is ATC's,
  not the agent's; a re-check after another landing pauses the clock but doesn't restart it, or a stopped winner in a
  busy repo would never hand over), and it only runs once its checks are in. A DO from before `fork_activity` counts
  every PR in flight as alive at its first start with this code (once), and falls back to when the head was seen,
  landing asked for, or an intent declared. A person picking a set-aside PR gives it a fresh start.
  - Only the PR's own agent should poll its clearance and signals: any caller naming the fork counts as its agent
    (identity isn't enforced, ADR-0005). A history read (`get_signals` with resolved ones) doesn't count. Polls are
    recorded only once a baseline has seen a task, and at most every `min(30 s, stallSeconds / 10)`.
  - Losers are told to keep polling ("…if PR2's agent goes quiet for 15 min, the task can pass to this PR"); the
    heir gets a `handover` signal. The reconcile alarm stays up while a task is contested, past the stall window, so
    the handover happens on time even if nobody calls. `stallSeconds` is in `/state`.
  - It gets STAND DOWN with basis `stalled` ("…its agent showed no sign of life (a push, a land request, an intent or a
    clearance check) for 15 min, so PR4 gets the task. Push or ask to land to compete again."), and the event `attempt.stalled` (once per stall).
  - Table `task_stalls` remembers when: it stays aside until its agent acts again. Without it, the heir becoming
    ATC's pick would restart the quiet one's clock and the two would swap back and forth.
  - When it acts again (any push or land request), it competes like any attempt; if it is still the better one, it
    ships. The heir's flight log says `ATC-Chosen-Over: PR3 (PR3 went quiet for 15 min)`.
  - A winner in HOLD or REVIEW whose agent keeps polling isn't quiet; one whose agent stopped is, and hands over.
- **After the winner lands**, the attempts that were in flight stand down **for good** ("PR2 already landed this
  task …"), shown even over GO AROUND, since rebasing changes nothing. The landing sends them neither a go-around nor
  "stay in line", and ATC doesn't re-check them then or later (other landings, pushes to main, the stuck-check
  restarts); they get a `stand_down` signal. Only a landing after the PR started naming the task counts (its oldest
  intent in its latest unbroken run of intents naming it), so a task key reused later, by a new PR or an old one, for
  a follow-up on the same ticket isn't blocked by an old landing.
  The winner's CLEARED reason says "Chosen over PR1 (same task)" when the loser conflicts with it; a PR outside the
  task is never credited with beating a loser, and FOLLOW doesn't list losers as waiting for it.
  If a final loser declares a new task, ATC re-checks it on current main right away (the landing had skipped it). To keep a loser's work (it adds something), the agent declares an
  intent with a new task and pushes; then it is an ordinary PR again.
- **A person can override:** `POST /choose {fork, by}` or the dashboard's PICK button on a STAND DOWN row (with a
  key, never on the public replay). Table `task_choices(task, winner, by, at)` keeps the latest pick per task. It holds across
  the picked PR's pushes (a go-around fix ATC asked for mustn't undo it) until someone picks again, or the picked PR
  is abandoned or leaves the task (declaring another task deletes the pick, so coming back doesn't revive it): a
  person's pick is a person's to change. The chosen PR still passes every other
  check. A pick needs another live attempt with pushed changes (final losers of an earlier landing don't count). Refused (409) for a PR with no task, the only attempt, a task that has
  already landed, or during a landing. When the pick differs from ATC's ranking the reason says so ("picked by … over
  ATC's ranking (which preferred PR2: …)"); when it agrees, ATC's reason is kept with "confirmed by …".
- **Flight log:** the winner's note gets `ATC-Chosen-Over: PR1 (<reason>)` (up to three). `stand_down` is a story
  signal, so a former loser that lands later under a new task shows that it once stood down.

## Consequences
- Best-of-N runs need nothing but a shared `task`: ATC picks and says why; nothing ships twice.
- A green attempt can wait for its rival's checks (bounded: checks always end, ADR-0021).
- Identity is not enforced for `choose`, as for reviews (ADR-0005): `by` is a label.
- A winner whose agent stopped hands over after `stallSeconds` (above), so the others wait at most that long. A PR
  that names a task only after it landed isn't stopped (`landedBy` tells it); that is left to the agents.
- A loser that keeps pushing makes the winner wait again for each push's checks (each wait is bounded). Not
  prevented: a later push may make it the better attempt, which is the point of comparing.
- With no intent naming a task (the default), nothing about attempts is computed: one meta read (`tasks_seen`,
  set by `declare_intent`). Once a baseline has seen a task, each read groups its intents by fork (indexed); fine at
  demo scale, worth a cache for very long-lived baselines.
- A loser's `stand_down` note stays open while its task is contested and nothing replaced it, so a winner's new push
  doesn't resolve and re-open it. Its key is (loser head, winner, basis: final, pick or the ranking step), not the
  counts in the reason, which update the note in place.
- The reconcile alarm re-syncs the notes too, since time alone can change a verdict (a sent-around pick's wait ends).
- The verdicts are recomputed from state on every read; the stand-down signals are synced when state is flushed
  (and on a refused landing or a pick), so they can lag the clearance by the 120 ms flush delay.
- `./demo/run.sh --attempts [--browser]` runs it end to end: two attempts, STAND DOWN, a pick (in a real browser with
  `--browser`), the landing and the git note; then a second task whose pick goes quiet (`stallSeconds` 20) and
  hands over by itself.

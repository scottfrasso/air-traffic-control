# ADR-0019: Flight log as a git note on the landed commit; savings computed from the event log

- Status: Accepted. Extends ADR-0014 (snapshots carry savings; the timeline carries flight logs) and ADR-0015 (a note follows each landing).
- Date: 2026-10-11. Issues #15 (context preservation) and #17 (savings in numbers).

## Context
Judging gives 25% to "concurrency, coordination, **context preservation**, review, conflicts" (ADR-0017). ATC knew
every PR's story (intent, signals, clearances, go-arounds) but threw it away on landing: main showed *what* changed, not
*why* it landed in that order. Separately, the usual objection ("agent collisions are rare, why coordinate?") needs
numbers: pairs checked, time to a conflict signal, and rebases avoided compared with rebasing everyone on every landing.

## Decision
- **Git note, not trailers.** Most landings are fast-forwards of the agent's own commit (ADR-0015). Trailers would
  mean rewriting that commit or always making a merge commit. A note under `refs/notes/atc` attaches to whatever commit
  landed and leaves the agent's commit untouched. Read it with
  `git fetch <baseline> refs/notes/atc:refs/notes/atc && git log --notes=atc`.
  - The note body is `Key: value` lines (`ATC-Intent`, `ATC-Signal`, `ATC-Clearance`, `ATC-Go-Around`, `ATC-Landed-Onto`, …),
    so `git interpret-trailers --parse` reads it too. Built by `flightLogNote` (`worker/src/flightlog.ts`).
  - Clearances come from the recorded snapshots (ADR-0014), one per *change* of clearance, plus the current sequence
    (the latest may not be flushed yet). Long histories keep the first 3 and the last 5.
  - Signals keep only the kinds that tell the story (conflicts, signature changes, overlaps, failed checks), one line
    per (kind, other PR, symbol). `landed` chatter is dropped; `rebase_required` becomes `ATC-Go-Around`.
- **Written after the landing is recorded, in the background.** The Coordinator builds the note *before* landing (the
  story up to that moment) and stores it in `flight_logs` with `noted = 0` when it records the landing. It answers the
  agent, then (`ctx.waitUntil`) makes a separate checker call (`mode: "notes"`) with **every** log not yet in git. The
  container fetches `refs/notes/atc` into a per-baseline local ref, adds the notes (on stdin), and pushes without force.
  - Why a separate call: work after the main push inside the land call could be killed by the checker's hard timeout,
    leaving a PR that is on main but not recorded as landed. Now the landing is recorded first, and the agent never
    waits on notes.
  - One writer per Coordinator (an in-memory promise): two notes pushes never race; a landing during a write makes the
    writer go round again. A failed write retries with backoff (2, 4, 8 s), and the reconcile alarm, which keeps running
    while any note is pending, retries after that.
  - A note is never replaced: a PR that added nothing new lands on a commit that already has a note, so ATC appends.
  - Only "couldn't find remote ref" counts as "no notes yet". Any other fetch error skips the write, because starting a
    new notes history would diverge from the remote one. Transfers use `http.lowSpeedLimit/Time` so a stall fails within ~10 s.
  - An in-flight log (`get_history` with `fork`) never claims a landing: no "landed after a new push", and
    `ATC-In-Flight-On` instead of `ATC-Landed-Onto`.
  - The note is bounded: the last 3 distinct intents, one line per signal kind/partner/symbol, at most 8 clearances.
- **A note failure never fails a landing.** `flight_logs.noted = 0` and `note_error` record it; the text is still served.
- **Spike (2026-10-11):** Artifacts accepts a push to `refs/notes/atc` and lists it in `ls-remote`. The push-event
  consumer only acts on `refs/heads/main`, so a notes push can't move ATC's idea of main.
- **Agents and people read it** through `get_history` (MCP) / `GET /history[?fork=]`: every landed PR's log, oldest first,
  plus the caller's own in-flight log. On the dashboard, click a parked plane (or its name under Landed).
- **Savings are a pure function of the event log** (`computeSavings`, `worker/src/savings.ts`), so a replay shows the
  same numbers as the live run. Definitions:
  - pairs checked = distinct PR pairs with a current-head pair result; conflicts = pairs that conflicted textually or by typecheck;
  - time to signal = first conflicting pair result − the later of the two PRs' latest pushes before it (a conflict first
    found by a re-check after main moved is measured from that older push, so it can overstate); the summary line shows the max;
  - typecheck cache hits = cached `typecheck *` steps / all typecheck steps in single and pair checks (not pair-level hits);
  - rebases = `rebase_required` signals; **naive** = for each landing, the number of other PRs still open;
  - wait = first `land.requested` → `land.merged`.
  `run.sh` prints `savingsLine` (e.g. `5 PRs · 10 pairs checked · 1 conflict found in 12 s · 1 rebase (naive: 10)`);
  the dashboard has a SAVINGS panel.

## Consequences
- One extra checker call per landing, after the agent has its answer: a fetch, `git notes add` and a push, about a second.
  A reader can see the landing a second or two before its note.
- Notes are not copied by a plain `git clone`; readers must fetch `refs/notes/atc` (documented in `get_history`).
- Savings are recomputed from the filtered event log on every flush: linear in the run's events, fine for the demo and
  tens of PRs; cache by last event id before a large synthetic load run. Savings in snapshots also mean a snapshot on
  nearly every check, and `flightLogNote` scans every snapshot's sequence: both want a `clearance_changes` table and
  cached counters before a large run. Snapshots carry savings (small) but not flight
  logs: those never change once written, so `GET /timeline` returns them once and the replay shows each from its `landedAt`.
- The notes path is covered by `run.sh` step 8, not by a container-level unit test.
- Older recorded runs have no `flightLogs` or `savings` in their snapshots; the dashboard shows empty panels for them.

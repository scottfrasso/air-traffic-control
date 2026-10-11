# ADR-0019: Flight log as a git note on the landed commit; savings computed from the event log

- Status: Accepted. Extends ADR-0014 (recorded snapshots now carry flight logs and savings) and ADR-0015 (the land step also writes a note).
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
- **Written in the land step, under the landing lock.** The Coordinator builds the note *before* landing and passes the
  same text to the container (`land.note`) and to `flight_logs`. After pushing main, the container fetches
  `refs/notes/atc` into a per-baseline local ref, adds the note (on stdin), and pushes without force. Landings are
  serialized, so the push fast-forwards; if it's rejected, nothing is overwritten. Each note git call has a 20 s limit:
  main is already pushed, and a stalled note must not use up the checker's budget (a killed land step leaves a PR that
  is on main but not recorded as landed until the agent asks again).
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
- One extra fetch and push per landing (inside the lock), a fraction of a second.
- Notes are not copied by a plain `git clone`; readers must fetch `refs/notes/atc` (documented in `get_history`).
- Savings are recomputed from the filtered event log on every flush: linear in the run's events, fine for the demo and
  tens of PRs; cache by last event id before a large synthetic load run. Snapshots carry savings (small) but not flight
  logs: those never change once written, so `GET /timeline` returns them once and the replay shows each from its `landedAt`.
- The land step's note path is covered by `run.sh` step 8, not by a container-level unit test.
- Older recorded runs have no `flightLogs` or `savings` in their snapshots; the dashboard shows empty panels for them.

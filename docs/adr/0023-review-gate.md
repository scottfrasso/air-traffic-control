# ADR-0023: An optional review gate: REVIEW clearance, approval per head

- Status: Accepted.
- Date: 2026-10-14. Issue #16.

## Context
"Review" is named in the judging criteria ("how does output get reviewed?"). ATC's only gate was the typecheck, by
design (prompt.md). Teams that want a reviewer (another agent, or a person) in the loop had no place for one.

## Decision
- **Off by default**, per baseline: `POST /api/repos/<baseline>/settings {"review": true}` turns it on. The scripted
  demo is unchanged unless run with `--review`.
- **Approval is per head.** Table `reviews(fork, sha, verdict, reviewer, note, at)` keeps each PR's latest review. A PR
  with pushed changes needs `verdict = approve` at its **current** head; a new push needs a new review (what was
  reviewed is no longer what would land). `request_changes` keeps it waiting with the reviewer's note.
- **REVIEW clearance.** A PR that would be CLEARED or FOLLOW but isn't approved shows REVIEW ("Waiting for review of
  <sha>") and is skipped as leader, so it doesn't hold up approved PRs behind it. HOLD, GO AROUND, STANDBY and the
  typecheck still come first. `request_land` answers `retry` with the same reason, as the last check before landing.
- **Who reviews:** an agent through the MCP tool `review(fork, verdict, note, reviewer)`, a person through the
  dashboard's APPROVE button (only with a key, never on the public replay), or `POST /reviews`. The author gets a
  `review` signal with the note. The note goes into the flight log as `ATC-Review: approved by <reviewer> (<note>)`.
- Identity is not enforced: every caller shares the API key (ADR-0005), so `reviewer` is a label, not a credential.

## Consequences
- With the gate on, landings wait for a reviewer; nothing lands unreviewed, including a fix pushed after approval.
- Self-review can't be prevented while all agents share one key.
- `./demo/run.sh --review` runs the same scenario with a scripted reviewer that approves each PR's latest push.

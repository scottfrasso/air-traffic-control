# ADR-0029: Checks run only when asked; a UI built around the check track

- Status: Accepted.
- Date: 2026-10-17.
- Amends ADR-0027 (what starts a review run; the web UI and the MCP tools).

## Context
Coding agents push hundreds of commits on a PR. ADR-0027 restarted the whole review (CI, then paid agent sessions) on
every push to a ready PR, and cancelled the run in progress. That spends money on commits nobody wants judged. The
agent knows when its work is done; it should say so. People, meanwhile, need to see at a glance which PRs need them,
what the checks found, and the diff with findings in place.

## Decision
- **A push never starts or stops anything.** `onPush` only moves the PR's head.
- **Run checks is explicit.** `runChecks(pr, by, { sha?, only? })`, exposed as `POST /api/repos/:repo/prs/:id/checks`,
  MCP `run_checks`, and the PR page's Run checks button. It runs the checks on the head; `sha`, if given, must be the
  head (409 otherwise), so an agent can't get a verdict for a commit other than the one it means. A draft becomes ready.
  `ready` and MCP `mark_ready` stay as aliases (all checks, no options).
- **Repeating is free.** The same request again for a head whose run, with the same scope, is running or done returns
  that run. A run that ended with CI failed or was cancelled can be run again (flaky CI). A run still going on an older
  head is cancelled when a new one starts: one run is in charge of a PR (ADR-0027's current-run rule is unchanged).
- **Results go stale instead of being thrown away.** A run in progress when a push lands finishes. The verdict gains
  `checks: not_run | running | done | partial | stale` and `checkedSha`; stale or not-yet-run checks block merge with
  a blocker that says what to do ("checks ran on X, the head is Y: run the checks again").
- **Single checks.** `only` is a subset of `ci`, `correctness`, `security`, `tests`, stored on the run (`runs.scope`,
  added by an in-place migration). A partial run skips the classifier, runs CI only if asked (otherwise records no CI
  result at all), runs the listed reviewers at standard depth with verification as usual, and never makes a PR
  mergeable: merging needs a full run on the head.
- **Dashboard API.** `GET /api/prs`: every repo's PRs, newest activity first, each with the verdict, open finding
  counts, step statuses and last activity (`RepoStore.listSummaries`).
- **UI.** One HTML file, no build step, textContent only. The memorable element is the check *track*: six stations
  (CI, risk triage, agent review with each reviewer, verification, approvals, merge), each a lamp (green, amber,
  red, pulsing while running, dashed when not part of the run). The dashboard groups PRs by whose turn it is
  (Needs you, Agent's turn, Running, Merged and closed), with a mini track and the next step in plain words. The PR
  page shows the track, the next step, a stale banner, Run checks with a menu of single checks, Approve and Merge,
  and tabs for an overview (why a person must look, the author's intent, open findings; fixed ones folded), files
  (file list, diff with findings under their lines), checks with logs, and activity. Risk is a label, not a red lamp:
  high risk isn't a failure. IBM Plex Sans and Mono from Google Fonts; the CSP allows only those two hosts.
- **Token sessions in the UI.** Until Access is set up, a person can paste a personal token. That session can read
  and run checks; Approve and answering important findings are disabled and say why (ADR-0027: only Access sign-ins
  approve).

## After review (same day)
A fresh review found that partial runs leaked into full ones. Fixed, each with a test that failed first:
- Only a **full** run is a "last reviewed commit" (`since`); a single check after it no longer hides the change since.
- Findings are marked **fixed only by a full run on a different commit**: not by a single check (which skips the
  hard rules and the risk floor), and not by re-running the same commit (not reporting a finding again is the model
  varying, not a fix). Otherwise an agent could re-run the security check until a finding it may not dismiss vanished.
- A single check that a **clean** full run on the head already covered returns that run, so it can't turn a mergeable
  PR into a partial one. A done run with any failed or errored check (a reviewer, CI at merge time) can be run again.
- `sha` may be 7+ characters, and naming a commit the push event hasn't delivered yet reads the branch's live head
  and moves the PR there (the queue lags the push).
- Every state change in `runChecks` happens before its first await, so two calls at once start one run; if the new
  run's Workflow can't start, the PR keeps its previous result.
- A finished partial run is never "in progress"; the dashboard API lists the repos it couldn't read instead of failing;
  `POST …/checks` rejects a non-object body and an empty `only`.
- UI: polling re-renders only when what's shown changed and never while someone types or has a menu open; Run checks
  works while a run on an older head is going; Close and Back to draft (while running) ask first; the run menu works
  from the keyboard; small coloured text meets 4.5:1.

## Consequences
- Agents decide when to spend: the e2e now pushes, sees the verdict go stale with nothing run, and triggers again.
- An agent that forgets to call `run_checks` leaves its PR stale; the dashboard shows it under "Agent's turn".
- A person can still trigger checks from the UI; there's no rate limit on triggers yet beyond "same head, same scope is
  the same run".
- The token pasted into the UI lives in localStorage, readable by any script on the page; the page runs only its own
  inline script under the CSP, and builds every element with textContent.

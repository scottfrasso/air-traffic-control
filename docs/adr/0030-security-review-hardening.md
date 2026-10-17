# ADR-0030: Hardening after the security and code-quality reviews

- Status: Accepted.
- Date: 2026-10-17.
- Amends ADR-0027 (merge gate, identity, agents, CI isolation), ADR-0028 (token bootstrap) and ADR-0029 (findings).

## Context
Two fresh reviews of the whole branch (one for security, one for code quality) found that the system's central claim,
"an agent can't get code onto main without a person", didn't hold: any token holder could push to main directly, a
page on another site could make a signed-in person's browser approve (CSRF), a renamed file escaped the protected-path
rules, and a malicious PR could talk the classifier down to zero approvals or get findings downgraded, hidden, or
marked fixed. The quality review found the diff base never moved, findings of one kind in one file overwrote each
other, and Workflow replays repeated every store write.

## Decision
**The merge gate is enforced, not advisory.**
- *main moves only by a merge.* Artifacts can't refuse a push to one branch, so `RepoStore.onPush` for `main` compares
  the live head with the last merged commit (`meta protected:main`, set by the first push of a new repo and by each
  merge) and, if a push moved it otherwise, puts it back (container mode `restore`, force-with-lease on the bad head,
  so a merge landing meanwhile is never undone). A push during a merge is left to the merge. Other target branches
  aren't protected yet. Verified live: a direct push was put back within 20 s on a repo whose events flow.
  - *Starting point:* main's head when the first PR into it is opened, or the first push event (if that event isn't
    main's creation, its `before`, since the creating event was missed).
  - *Events aren't enough.* A new repo's push subscription delivers nothing for its first minutes (seen live: every
    push in a repo's first ~15 s was never delivered), and events can be lost. So the store also checks main on a
    Durable Object alarm every 2 minutes; verified live: an immediate direct push to a new repo was put back after
    120 s. `GET /api/repos/:repo/events` lists `branch.protected`, `branch.restored` and `branch.restore_failed`.
- *CSRF.* A request that changes something and carries no bearer token (so it came from a browser with the Access
  cookie) must have `Origin` equal to the Worker's and `content-type: application/json`; otherwise 403.
- *The model can't lower the bar.* Security reviews every code change, like correctness. Every change needs one person
  unless main's `.atc/review.yml` sets `minApprovals: 0` (then low risk with no reason for a person needs none). The
  PR's title, branch names and file names reach agents only inside `pr.json` and `diff.patch`, as data; titles are one
  line, at most 200 characters, and intent fields are strings of at most 2000.

**Findings can't be laundered.**
- Changed paths are listed with `--no-renames`, so a rename shows both paths to the owners and always-human rules.
- An answered finding hides only the same bug (file and class) within 5 lines, at the same or lower severity: answering
  a nit can't hide a later important finding there.
- Across reviewers, duplicates keep the most severe report; a re-report (an earlier run's finding, same reviewer, file
  and class, near the line) never lowers severity. Within one run, two reports are two findings.
- A finding becomes fixed only through a full run on a different commit that changed its file since the last review.

**Cost is bounded.** Budgets and `minApprovals` come from main, whatever target the PR names. A repo starts at most
100 runs a day (`REVIEW_MAX_RUNS_PER_DAY`; 429 past it). Runs record their agent sessions, and cancelling a run
interrupts them. Starting a session is never retried (a lost response would start a second, untracked one). A person
creates at most 50 repos.

**CI isolation.** Each CI job runs as its own throwaway uid (root container), everything that uid still runs afterwards
is killed (`pkill -U`, which also catches `setsid` escapes), and jobs get a 4 GB file-size limit and 512 processes.

**Identity.** Only an Access sign-in creates or revokes personal tokens; tokens expire after 90 days. The admin
bootstrap is off unless `ADMIN_SECRET` has at least 32 characters. A JWT naming an unknown key forces a re-fetch of the
Access keys at most once a minute. Git credentials are handed out as environment variables, never as `git -c` argv.
MCP refuses unregistered repos. The container base image is pinned by digest, and setup won't give the Worker the
deploy token unless asked (`--worker-uses-deploy-token`).

**Quality.** The PR's diff is three-dot against the target's current head (cached per target head), so merging main
into a branch doesn't grow the PR. Every store write in a review run is its own durable step. A single check asked for
during a full run on the same head joins it. One time limit covers a merge's push token and lock. The verdict carries
`needsNonAuthor` and `openImportant`, so the UI doesn't parse blocker text. Tests and the container script are
typechecked.

## Consequences
- The e2e repo's first push of main sets its protected commit; a person who pushes straight to main sees it put back
  (the event log says `branch.restored`). Merging through a PR is the only way in.
- Every PR costs one more Sonnet session (security always runs) and, by default, a person's approval.
- Known limits, not fixed here: an Access session on the person's own machine can be used by an agent there to approve
  (a step-up confirmation would close it); a restore happens after the bad push lands, so the commit is briefly on main
  and visible to anyone who fetches in that window; only main is protected.

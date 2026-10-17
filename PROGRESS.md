# PROGRESS

_Last updated 2026-10-17. Direction: PRs and an agent review pipeline on Cloudflare (ADR-0027)._

## Live (2026-10-17)

- Deployed as a separate Worker, **https://agentmesh-review.scottfrasso.workers.dev** (`agentmesh-review`, own queues
  `agentmesh-review-push-events` + DLQ); the ATC Worker `agentmesh` is untouched.
- Agents: classifier on Haiku 5.5, correctness / security / tests / verifier on Sonnet 5.5. Default budgets 50 / 200 / 30 cents.
- `pnpm e2e:review` **passes** against real Managed Agents: both planted bugs found, verified and blocking; after the
  fix the follow-up review is clean and merge waits for a person (high risk, 2 approvals). About 4 minutes and
  **$0.34** a run (14 sessions); the first run, before cross-reviewer dedupe, was $0.81 (33 sessions).
- **No Cloudflare Access yet.** A temporary `ADMIN_SECRET` (Worker secret, in `.env`) mints personal tokens via
  `POST /api/admin/tokens`; they can't approve, so nobody can approve a merge in the UI until Access is set up
  (`handover/access-setup-prompt.md`). Remove the bootstrap then.

## Done

- **PR lifecycle** (`worker/src/review/store.ts`): draft → ready → merged / closed; a push to a draft moves its head and
  runs nothing; ready starts one review run per head; a push to a ready PR cancels the run and starts a new one; a
  cancelled run's late writes are refused. Diff for the UI per head commit, cached.
- **Review run** (`orchestrate.ts`, `workflow.ts`): snapshot (container: git archive + diff + config) uploaded once;
  CI gate from `.atc/ci.yml`; classifier with hard rules after it; correctness / security / tests reviewers in
  parallel; one verifier session per important finding (2 of 3 votes); budgets per session; errors, budget, timeouts
  and invalid output error that step (review incomplete → a person must approve); resolved findings never repeat;
  follow-ups review only the diff since the last reviewed commit; no new nits after 3 runs. Without the Anthropic
  configuration, CI still gates and every agent step is errored.
- **Policy** (`policy.ts`): verdict, tiers 0/1/2 approvals, approvals per commit, author counts once (by approving),
  high risk needs a non-author, merge gate with readable blockers.
- **Container** (`container/check.ts`): modes snapshot, diff, ci (per-command timeouts, minimal environment, stops at
  the first failure), merge (head onto target, CI on the merged commit, push only if green; retry if the target moved).
  Stderr progress and a process list on a hard timeout, for diagnosing hangs.
- **Identity** (`identity.ts`, `directory.ts`): Cloudflare Access JWT verification (RS256, aud, exp, issuer, key
  rotation) and personal API tokens (hashed, revocable).
- **API, MCP, UI** (`api.ts`, `mcp.ts`, `ui.html`): repos, git credentials, PRs, ready/draft/close, approve, resolve,
  merge, tokens; MCP `open_pr`, `mark_ready`, `get_pr`, `resolve_finding`; web UI rendered and checked in headless
  Chromium against a mock API (desktop and phone width).
- **Setup**: `pnpm setup:agents` (Managed Agent definitions + sandbox environment; `--dry-run` tested),
  `pnpm setup:cloudflare` (queues, namespace, deploy with `CF_API_TOKEN` and `ANTHROPIC_API_KEY`), and the live
  end-to-end script `pnpm e2e:review` (two planted bugs must be found, verified, blocked, fixed; passes live).
- A fresh whole-branch review (draft PR #50) found 3 critical and 9 important issues; all fixed, each with a test that failed first.
- Tests: `pnpm test` (worker 156, demo 6), strict TypeScript in both packages.

## Next

1. Cloudflare Access in front of the Worker (pages only; `/api` and `/mcp` bypass), then drop the admin bootstrap.
2. Dedupe still lets some through (same bug, different lines or wording); measure on more PRs before tuning.
3. Spikes left: the concurrent-session cap and session runtime limits (not hit at 14 sessions a run).
4. First real repo.
4. Later specs: per-repo permissions, comment threads between people, notifications, an eval set of known-buggy and
   known-clean PRs (noise measurement), a code browser.

## Stubbed, simplified, or open

- Every signed-in person can read and push every repo (no per-repo permissions yet), and there is no branch protection:
  a direct push to a target branch bypasses the merge gate until that slice lands.
- An agent and the person whose token it uses are one identity: the person is accountable for what the agent does.
- The classifier and reviewers are prompts plus Managed Agents defaults; nothing is tuned on real PRs yet.
- One verifier session gives three votes; three separate sessions would be more independent (and cost 3×).

## History

Air Traffic Control (2026-10-10 to 10-16): the hackathon entry, submitted 2026-10-14. Its progress log, demo and
dashboard are in git history before ADR-0027.

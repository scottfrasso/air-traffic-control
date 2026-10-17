# ADR-0027: Pull requests and an agent review pipeline replace Air Traffic Control

- Status: Accepted. Amended by ADR-0028 (models, budgets, reviewer lanes and dedupe, token bootstrap) and ADR-0029
  (checks run only when asked, not on push or ready; the UI).
- Date: 2026-10-17.
- Supersedes the ATC runtime ADRs (0005–0008, 0011–0015, 0018–0021, 0023, 0024, 0026); amends 0009, 0010 and 0025.

## Context
ATC coordinated many agents landing on one main: speculative pair merges, a landing sequence, clearances. After the
competition the direction changed: build the review side of a code host on Cloudflare, so that a change gets the least
human review time that doesn't raise reverts (after "Solving code review at Anthropic"). Ordering merges is no longer
the problem to solve; reviewing each change well, and knowing when a person must look, is.

## Decision
- **Pull requests on Artifacts branches.** One `RepoStore` Durable Object per repo holds PRs (draft → ready → merged
  or closed), review runs, checks, findings, approvals and an event log. A PR is a source branch into a target branch
  in the same repo. Push events for every branch arrive through the existing per-repo queue subscription (ADR-0002).
- **Drafts run nothing.** Marking a PR ready starts one review run for its head commit (a `ReviewRun` Workflow,
  instance id from PR, sha and run). A push to a ready PR cancels the run and starts one for the new head; back to
  draft cancels it. Every write from a run goes through the store, which refuses it once the run isn't current, so a
  cancelled run's late results never land on a newer head.
- **Stages** (`review/orchestrate.ts`, plain orchestration over injected dependencies, each call a durable step):
  1. snapshot in the checker container (git archive and the PR's whole diff and changed paths; on follow-ups also
     `since.patch`, the delta since the last reviewed commit), uploaded once to the Managed Agents Files API. CI
     config comes from the PR head; `REVIEW.md`, `.atc/review.yml` and `.atc/owners` come from the **target** branch,
     so a PR can't rewrite the rules or budgets it is reviewed by;
  2. **CI gate**: the repo's `.atc/ci.yml` commands in the container, each a check with its own timeout and a minimal
     environment (no container variables, no tokens); any failure ends the run before any agent runs; no config is
     shown as "not configured" and needs a person;
  3. **classifier** session → risk tier, needs-human, which reviewers, depth, always judged on the **whole** change;
     hard rules raise it afterwards (`.atc/ci.yml`, `.atc/review.yml`, `.atc/owners`, `REVIEW.md`, owner globs
     always need a person); a follow-up's classification never drops below the previous run's; a failed classifier
     means all reviewers and a person;
  4. **reviewers** in parallel: the classifier's pick, plus correctness on any change, plus every reviewer that
     still has open findings; each writes `review.json`;
  5. **verification**: one verifier session per important finding (at most 5 per reviewer; the rest go up
     "[unverified]" and still block), exactly three votes, posted at ≥ 2 real; nits (≤ 5 per reviewer) and
     pre-existing findings go up unverified and never block; a verifier that fails doesn't hide the finding
     (posted "[unverified]", review incomplete).
  Any unexpected failure interrupts the live sessions and finishes the run (CI errored if CI hadn't run, else an
  errored `pipeline` step), so a PR is never "in progress" forever; a Workflow that fails to start leaves no run
  behind and Ready starts it again. Push events are applied by the branch's live head, never the event's sha.
- **Agents are Claude Managed Agents** behind an `AgentClient` interface (`ManagedAgentsClient` over fetch;
  `FakeAgentClient` in tests). Definitions (`atc-classifier`, `atc-correctness`, `atc-security`, `atc-tests`,
  `atc-verifier`) are created by `pnpm setup:agents` (classifier on Haiku 5.5, the rest on Sonnet 5.5, for cost); the sandbox environment allows package registries only.
  **No repo credential ever enters a sandbox**: sessions get read-only file resources. Prompts treat repo and PR
  content as data. Every session has a budget (US cents: classifier 50, reviewer 200, verifier 30; per repo in
  `.atc/review.yml`, capped at 500/2000/200). Only the role's output file is downloaded, at most 256 KB. Polling backs
  off from 10 s to one a minute. A session that fails, hits its budget, times out or writes invalid output errors its
  step.
  Without the Anthropic configuration, every agent step errors: CI still gates, and a person must approve.
- **Verdict and merge policy are code, not a model** (`review/policy.ts`): CI pass/fail/none; review clean,
  findings, incomplete; security clear/blocking; tier low/medium/high → 0/1/2 human approvals, needs-human raises
  to ≥ 1. Approvals are per commit (a push makes them stale); an agent never approves: an approval must come from a
  Cloudflare Access sign-in, never an API token (tokens are what agents use); the author counts as one approver by
  approving the commit; high risk needs someone other than the author. Resolving an important finding also needs an
  Access sign-in, so an agent can't dismiss its own finding. Merge only when ready, CI green,
  no open important or security finding, enough current approvals, and not incomplete unless a person approved.
- **Convergence**: a finding the author resolved (wrong, intentional, won't fix, with a reason) isn't raised again
  for the same file and class; from the second run reviewers see only the diff since the last reviewed commit plus
  the open findings, which they re-report if still real (others become fixed); after three runs no new nits.
- **CI isolation**: CI commands run in their own process group (killed when they finish), with a minimal environment,
  and as an unprivileged `ci` user when the container runs as root; git gets its token through its environment,
  never its argv.
- **Merge** in the container: the PR head onto the target's current head, the PR's CI on that exact commit, a
  fast-forward push only if it passes; one retry if the target moved; one merge at a time per repo.
- **Identity**: Cloudflare Access in front of the UI (a verified email on every request), personal API tokens
  (hashed at rest, revocable) for the API, git and MCP; a `Directory` Durable Object holds people, tokens, repos. The
  shared API key (ADR-0005) is gone. In this slice every signed-in person can read and push every repo.
  **Temporary bootstrap** (until Access is configured): `POST /api/admin/tokens {email}` with `Bearer <ADMIN_SECRET>`
  (a Worker secret; unset turns it off) mints a personal token for that email. It is an ordinary token, so it can't
  approve or resolve important findings. Remove it, or unset the secret, once Access is in front of the UI.
- **Surfaces**: a web UI (repos, tokens, PR list, PR page: verdict, checks with logs, findings inline in the diff,
  Ready / Draft / Approve / Resolve / Merge), a JSON API, and MCP tools for coding agents (`open_pr`, `mark_ready`,
  `get_pr`, `resolve_finding`).
- **Removed**: the Coordinator, landing sequence, pair checks, clearances, flight logs, savings, competing
  attempts, runway dashboard, public replay, the ATC demo and the video tooling. They stay in git history.

## Consequences
- The pipeline is fully tested with fakes (store, container modes against local git, orchestration, policy,
  identity, API, UI contract), but not yet against real Managed Agents. Spikes before relying on it: the
  concurrent-session cap, session runtime limits, the Files API and agent-list endpoints used by `setup:agents`, and
  how reliably agents write their output file.
- Deploying this replaces the ATC Worker: the `Coordinator` class and the push-pipeline Workflow are no longer
  bound, so the first deploy may need a Durable Object deletion migration.
- Review cost is bounded per session by budgets; a PR with many important findings pays one verifier session each.
- No per-repo permissions, notifications, comment threads between people or evals yet (later specs).
- No branch protection yet: anyone with git credentials (an agent included) can push straight to a target branch,
  so until that slice lands the merge gate is advisory for direct pushes.

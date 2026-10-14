---
name: shipping-issues
description: Use when given one or more GitHub issues (by number, label, or "the next step in the plan") to fix in this repo and deliver as a pull request, or when asked to "take issue #N to a PR", "ship these issues", or "do the issue → PR → review loop".
---

# Shipping issues to a reviewed PR

## Overview

Take GitHub issues from "open" to "PR that is green and independently reviewed". **Merging is not part of the
default loop: merge only when the user explicitly says to merge in this conversation.** "Get it in a PR",
"ship it", "looks good" and a clean review are not merge instructions.

## The loop

1. **Sync.** `git fetch origin`. Check `git status` (stash nothing without asking). Branch from **`origin/main`**,
   not local `main` (local `main` may carry unpushed commits that must not ride along):
   `git switch -c fix/<short-topic> origin/main`. If the fix depends on unpushed local commits, stop and ask.
2. **Understand.** `gh issue view <N>` for each issue; read the referenced file:line refs and acceptance criteria.
   Read `AGENTS.md` and `PROGRESS.md`. Ask the user **before coding** if anything is ambiguous: conflicting
   acceptance criteria, a behaviour change users will notice, a fix that needs a decision (ADR), or scope beyond
   the issue. Otherwise proceed and state your assumptions.
3. **Fix and test.** Put testable logic in pure helpers; add the tests each issue asks for. Then verify as fully
   as the change allows (see Project specifics). Report failures with output; don't claim untested things.
4. **Records, then PR.** Before opening the PR, bring the architecture decision records up to date:
   - Read the ADRs in `docs/adr/` that the change touches (grep for the files, tables and terms you changed).
   - A new decision, trade-off or invariant → a new ADR (`docs/adr/NNNN-<topic>.md`, same format as the others).
     Number it after the highest ADR on **local `main` and the branch** (`git ls-tree --name-only main docs/adr/`),
     so it can't collide with unpushed ADRs.
   - An existing ADR the change contradicts or tightens → update it (or mark it superseded and link the new one).
   - A new gotcha found while testing → add it to the ADR it belongs to.
   - Update `PROGRESS.md` (and `DECISIONS.md` if it indexes the decision).
   One commit per logical change, message ending in `Closes #N`. `git push -u origin <branch>` (push only the branch, never `main`).
   `gh pr create` with: what changed per issue, how it was verified (commands + results), behaviour changes,
   and which ADRs were added or updated.
5. **Green.** `gh pr checks <PR> --watch`. If a check fails, fix on the branch, push, re-watch. Not green = not done.
6. **Independent review.** Dispatch a fresh general-purpose subagent (background) with only the PR number and
   repo path — not your reasoning. Its prompt must say: read-only (no edits, commits, pushes, PR comments,
   deploys); never switch the main working tree's branch (use `git show <branch>:<path>`, or a temporary
   `git worktree` it removes afterwards); read the issues' acceptance criteria; hunt races, lost work,
   stuck states, migration issues, tautological tests; report each finding with severity, file:line,
   concrete failure scenario, fix; end with a verdict. Tell it that `pnpm --dir worker typecheck` fails in a fresh
   worktree (generated `worker-configuration.d.ts` is gitignored), so it doesn't report that. Relay the findings.
7. **Act on the review.** Verify each finding against the code yourself (use superpowers:receiving-code-review).
   Fix real ones on the branch, re-test, update ADRs again (step 4), push, back to step 5 and run a **fresh** reviewer.
   Push back on wrong ones with evidence. Repeat until the verdict is "merge".
8. **Stop and report.** PR link, check status, review verdict and what you did about each finding.
   **Then wait.** Merge (`gh pr merge <PR> --squash --delete-branch`) only if the user explicitly asks.
   After a merge, offer to rebase local `main` onto `origin/main`.

## Project specifics (cloudflare-hackathon)

| Step | Command |
|---|---|
| Typecheck | `pnpm -r typecheck` |
| Worker unit tests | `pnpm --dir worker test` |
| Deploy (Worker changes) | `cd worker && set -a && . ../.env && set +a && NODE_OPTIONS=--dns-result-order=ipv4first pnpm exec wrangler deploy` |
| End to end | `NODE_OPTIONS=--dns-result-order=ipv4first ./demo/run.sh` (must print `DEMO PASSED`) |

- After a deploy that changes a Coordinator ↔ Workflow RPC shape, wait about a minute before `run.sh`: new Workflow
  instances can briefly call a Coordinator still on the old version (ADR-0009). A failure in that window is not
  evidence about the code; check `wrangler workflows instances describe agentmesh-push-pipeline <id>` and rerun.

- `CLOUDFLARE_API_TOKEN` is IP-filtered; error `9109 Cannot use the access token from location` means the
  current IP isn't allowed. Tell the user; don't work around it.
- Never print `.env` values. pnpm only. Only touch `agentmesh*` Cloudflare resources.
- Repo is private; never change visibility or submit the competition form.

## Red flags: stop

| Thought | Reality |
|---|---|
| "Review is clean, I'll merge" | Not without an explicit "merge" from the user. |
| "User said ship it / get it in a PR" | That means open the PR, not merge it. |
| "Checks are still running, close enough" | Wait for green. |
| "I'll branch from local main, it's simpler" | It drags unpushed commits into the PR. Use `origin/main`. |
| "The reviewer can see my reasoning to save time" | Then it isn't independent. PR + issues only. |
| "It's a small fix, no ADR needed" | If it changes a decision, invariant or trade-off an ADR states, update the ADR. |

---
name: writing-handovers
description: Use when the user wants to hand over, wrap up, checkpoint, or "write a handover" before clearing the context (/clear) or starting a fresh session, or when a session's context is getting long and the next piece of work should continue in a clean context.
---

# Writing a handover for a clean context

## Overview

A handover lets a fresh session with **no memory of this one** do exactly one next piece of work. It is scoped to
what comes next, not a diary of what happened. Before writing it, the working tree must be clean: everything done
is committed (and pushed if it lives on a PR branch), so the next session starts from git, not from your memory.

## Steps

1. **Finish and check in.**
   - `git status` on every branch you touched. Uncommitted work is either finished and committed (after its
     verification: typecheck, tests, and whatever the change needs) or explicitly listed as unfinished in the handover.
   - PR branches: pushed, `gh pr checks <PR>` green. Never push `main` or change repo visibility (see `AGENTS.md`).
   - `PROGRESS.md` and ADRs (`docs/adr/`) reflect what's done (see the shipping-issues skill, step 4).
   - Switch back to the branch the next session should start on, normally `main`.
   - Don't commit junk (`.DS_Store`, scratch files) or anything from `.env`.
2. **Pick the scope.** One next piece of work, the one the user names or the next step in the current plan
   (`handover/04-next.md`, `gh issue list --label competition`). If the user hasn't said and the plan is ambiguous, ask.
3. **Write `handover/NN-<topic>.md`.** `NN` = next number after the highest in `handover/`. `handover/` is gitignored:
   that's expected, the file is local. Use the template below.
4. **Point the plan at it.** If `handover/04-next.md` (or the current plan file) lists this step, add a one-line link
   to the new handover so the two don't disagree.
5. **Give the user the restart prompt**, ready to paste after `/clear`:
   `Read AGENTS.md and handover/NN-<topic>.md, then start.`

## Template

```markdown
# Handover: <the one task> (<date>)

Written <YYYY-MM-DD> for a fresh session with no prior context. Read `AGENTS.md` first, then this file.

## Goal
<What done looks like, in 2–4 lines. Link the issue(s).>

## Where things stand
- Branch / PRs: <branch to start from; open PRs with number, status, review verdict>
- Deployed: <what's live, version or commit; or "not deployed">
- Unpushed / uncommitted: <anything, or "nothing">

## Do this
1. <Concrete steps, with file:line refs and commands. Name the skill to use, e.g. shipping-issues.>

## Done when
- <Acceptance checks, each verifiable with a command or a visible result.>

## Gotchas
- <Only what this task will hit: secrets, IP-filtered token, deploy skew, things not to touch.>

## Out of scope
- <Tempting adjacent work to leave alone, with where it's tracked.>
```

## Rules for the content

- **Self-contained.** No "as discussed", "the bug above", or references to this conversation. Paths, issue
  numbers, commands, commit shas and PR numbers instead.
- **Facts only from git, GitHub or files you checked.** Run `git log`, `gh pr view`, `gh pr checks` while writing; don't
  rely on memory.
- **Never put secret values in it.** Name the `.env` variable instead.
- **Short.** About a page. Background the next session can read in the repo gets a link, not a summary.

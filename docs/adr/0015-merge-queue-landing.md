# ADR-0015: Merge-queue landing. Only real conflicts go around.

- Status: Accepted. Supersedes the "fast-forward only / everyone rebases" parts of ADR-0011.
- Date: 2026-10-10. Requested by the project owner ("every landing should not send everyone around").

## Context
With fast-forward-only landing, every landing made every other PR stale, so every agent had to pull main and push again,
even for unrelated work. That wastes agent time and contradicts the picture of an orderly landing sequence.

## Decision
- **Green** now means: *this PR, merged onto the current main, typechecks.* It's computed by the Checker `single` mode
  (`ontoBase` + tree-cached `tsc`) and stored with `check_base` = the main commit it was checked on.
- **Landing = merge queue.** The `land` mode merges the PR onto the current main in a scratch worktree (or uses the PR head
  if it already contains main), typechecks that exact commit, and pushes it. The push is a fast-forward of main, because the merge's first
  parent is main. Commits read "Land PRn via ATC".
- **After a landing, ATC announces it.** PRs with an open semantic or textual conflict against the winner get
  `rebase_required` (GO AROUND, with symbol and error). Everyone else gets a `landed` note ("stay in line, no rebase needed")
  and is **re-checked automatically** on the new main (`PushPipeline` kind `recheck`, with id suffixed by the main sha).
- If a PR no longer fits on the new main (a combination effect pairwise checks didn't predict), the recheck or the landing
  check fails with `mainConflict`, and only then does that PR go around, with the exact error.
- A new push from a PR clears its go-around state; the checks on that push decide.

## Evidence
- Scripted 5-PR demo: only PR2 (real conflict) went around. PR3–PR5 landed with no rebases ("Land PRn via ATC"), the final main
  typechecks, and the run took about 56 s.
- Two real Claude Code agents ran concurrently (discounts vs checkout). Checkout landed first, and discounts was told to go around
  because it didn't fit on the new main. It merged main, fixed the other agent's new caller, and landed. The final main typechecks.

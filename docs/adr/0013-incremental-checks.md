# ADR-0013: Compute main once, then check only deltas

- Status: Accepted
- Date: 2026-10-10
- Suggested by the project owner.

## Context
A pair check ran `tsc` three times from a fresh clone (A alone, B alone, merge). On a real repo, full typechecks dominate.

## Decision
`container/check.ts` keeps a cache for the life of the warm container:
1. **One persistent repo** whose object store accumulates every baseline and fork commit, so each check fetches only deltas.
   Typechecks run in throwaway `git worktree`s.
2. **Typecheck results keyed by git tree hash.** A tree is never checked twice. A fork's "alone" result is computed once and
   reused by every pair it's in, and identical trees (for example, a merge equal to a fork after a rebase) are free.
3. **Main's TypeScript incremental state** (`.tsbuildinfo`, TypeScript 7 native) is built once per baseline tree and copied
   into each worktree, so `tsc` re-checks only changed files and their dependents.
4. Every result carries `timings`, which are logged in `check.pair` events.

## Evidence
- Local, same pair twice in one container: run 1 had 3 × tsc at about 1 s each; run 2 served all 3 from cache (0 ms), with cheaper delta fetches.
- 400-file synthetic project: full check 1.64 s, versus 1.26 s with main's incremental state (about 25%). TypeScript 7 is already fast,
  so most of the remaining time is file reading and parsing.
- Deployed 5-PR demo: 60 typecheck requests, 22 cache hits, average tsc 243 ms on `standard-3`. Main state was built 8 times.

## Concurrency and cache safety (issue #8, 2026-10-14)
- Concurrent checks in one container are separate processes sharing `/cache/repo`. Git fails (it doesn't wait) on
  `index.lock` and ref locks, so one lock directory (`/cache/git.lock`, `mkdir` is atomic) serialises every git command
  that writes refs or worktree metadata (`init`, `fetch`, `update-ref`, `worktree`, `notes`), and each fetch is held
  together with the `rev-parse` of its ref. A lock whose owner pid is dead (the hard timeout kills processes) or that is
  older than 5 min is broken. Typechecks and merges in their own worktrees still run in parallel. `gc.auto=0`.
- Cache files (`tc/*.json`, `tsbuild/*.tsbuildinfo`) are written to `<file>.tmp.<pid>` and renamed into place.
- Only real tsc outcomes are cached: a pass, or exit 1/2 with tsc diagnostics. A crash, a kill or a missing `tsc` is
  the environment; caching it by tree hash would make a transient failure permanent.
- `worker/test/container.test.ts` runs `check.ts` locally (Node + git + tsc, `ATC_CACHE`/`ATC_WORK` point at temp
  dirs): four pair checks in parallel on one cache, and a missing-`tsc` run that isn't cached. Without the lock the
  parallel test fails reliably on concurrent `git init`; the fetch/worktree races didn't reproduce locally at 4-way.

## Consequences / next
- The cache is per container. The 3-container pool (ADR-0010 follow-up) splits it. Routing by fork, or passing ATC's known
  alone results into pair checks, would raise the hit rate.
- The cache is lost when the container sleeps (10-minute inactivity), and it's rebuilt lazily.

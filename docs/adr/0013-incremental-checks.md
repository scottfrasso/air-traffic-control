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

## Consequences / next
- The cache is per container. The 3-container pool (ADR-0010 follow-up) splits it. Routing by fork, or passing ATC's known
  alone results into pair checks, would raise the hit rate.
- The cache is lost when the container sleeps (10-minute inactivity), and it's rebuilt lazily.

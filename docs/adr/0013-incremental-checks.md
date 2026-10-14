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
  together with the `rev-parse` of its ref. Typechecks and merges in their own worktrees still run in parallel.
  `gc.auto=0`. The lock protocol (tightened after review of #34):
  - **Acquire by rename:** a process builds `git.lock.<pid>/pid`, then renames it to `git.lock`. The lock never exists
    without an owner, and renaming onto a held (non-empty) lock fails atomically.
  - **Break once:** a lock whose owner pid is dead (the hard timeout kills the process group), or older than 5 min, or
    an ownerless dir older than 10 s, is broken only under a `git.lock.break` guard, after re-reading that it's still
    the same owner. Two waiters can't both break it and remove each other's live lock.
  - **Release only your own** (the pid file must match), and remove by rename-then-delete.
  - **Fetches are bounded** (60 s, and the low-speed limit), so a stalled remote can't hold the lock until the hard timeout.
- Cache files (`tc/*.json`, `tsbuild/*.tsbuildinfo`) are written to `<file>.tmp.<pid>` and renamed into place.
- Only real tsc outcomes are cached: a pass, or exit 1/2 with tsc diagnostics. A crash, a kill or a missing `tsc` is
  the environment; caching it by tree hash would make a transient failure permanent.
  A missing module (TS2307) is a tsc diagnostic and is cached. That is deliberate: the container never installs
  packages, so for a given tree the result is stable, not transient.
- `worker/test/container.test.ts` runs `check.ts` locally (Node + git + tsc, `ATC_CACHE`/`ATC_WORK` point at temp
  dirs): four pair checks in parallel on one cache, a missing-`tsc` run that isn't cached, six checks contending for a
  lock left by a dead pid, and an old ownerless lock dir. Without the lock the
  parallel test fails reliably on concurrent `git init`; the fetch/worktree races didn't reproduce locally at 4-way.

## Routing and shared work (issue #9, 2026-10-14)
- **Before:** each push's checks were spread over the pool by the sorted pair key, and inside one container the
  concurrent checks of one push all built main's TypeScript state and typechecked the fork alone at the same moment.
  Three 5-PR demo runs measured main's state built 12–14 times and cache hits 32–46%.
  Routing by fork alone, and then per-tree locks, left it at 12 builds. The timelines showed why:
  before the first landing main was built only 3 times. The other 9 came after landings: each landing re-checked
  the remaining PRs, each in its own container, and each container built the new main (3 containers × 3 mains).
- **Now:**
  - All of one push's checks (its check on main and its pair checks) go to the pushing fork's container.
  - Re-checks after main moved go to the landing container, which already has the new main: one build per landing.
  - A per-tree lock (the same lock protocol as the git lock) makes one process build main's state or typecheck a
    tree while the others wait for its cached result.
  - `savings` counts `mainBuilds` and `pairCheckMs`, and `run.sh` prints them, so the effect is measured on every run.
- **After** (two 5-PR runs, `shop-261014210117`, `shop-261014210231`): main built **7–8×** (was 12–14×). Cache hits stay
  around 30–40%: most misses are merges, which are new trees. (Landings' own builds aren't logged as events, so both
  counts are slightly low.) No claim about pair-check time: the old metric summed recorded steps, which misses time
  spent waiting on a lock and then reading the cache. Checks now record a `total` wall-time step and `pairCheckMs` uses
  it, so future runs can compare (review of #36).
- **Limits** (review of #36):
  - If the lock holder's tsc run produces nothing cacheable (killed, crashed), the waiters re-run it one after another,
    where before they ran in parallel.
  - Work is concentrated on fewer containers: the landing container also runs every re-check after a landing, and one
    push's checks share one 2-vCPU container. That's fine at demo scale (tsc about 1 s). On a repo with 30 s typechecks
    and ten PRs, re-checks would approach the 240 s limit; capping concurrent tsc runs per container would be next.
- The lock's "ownerless dir" break branch is gone (a lock always has a pid file, and an empty dir is replaced by the
  rename). Zombies count as dead, since the container's PID 1 never reaps. tsc exit 2 (a crash) isn't cached.
  (Review of #34.)

## Consequences / next
- The cache is per container. The 3-container pool (ADR-0010 follow-up) splits it; routing (above) keeps each push in one
  container. Passing ATC's known alone results into pair checks would raise the hit rate further.
- The cache is lost when the container sleeps (10-minute inactivity), and it's rebuilt lazily.

# PROGRESS

_Last updated 2026-10-15. The competition entry is submitted; the repo is public._

## Submission

- Submitted 2026-10-14 by the owner (form record in `submission/SUBMITTED.md`). The repo `scottfrasso/air-traffic-control`
  is public with an MIT license. The submitted video is `submission/atc-demo.mp4` (v8, 6:52); a 60-second cut is
  `submission/atc-linkedin.mp4`.
- Public read-only replay for judges: https://agentmesh.scottfrasso.workers.dev/r/shop-261011185716?replay (ADR-0020).

## Blocked

Nothing.

## Notes

- Workers Paid is active. The Worker's Queues-only subscription token is installed (`CLOUDFLARE_AGENTMESH_WORKER_API_KEY` → secret `CF_API_TOKEN`).
- The main `CLOUDFLARE_API_TOKEN` (deploys, seed/teardown, `run.sh`) expires **2026-10-15 21:59 UTC**: rotate it before deploying or running
  the demos after that. The running Worker doesn't use it (it has its own Queues-only token).

## Works (verified against deployed Cloudflare resources)

- **Acceptance test:** `./demo/run.sh` passes end to end, all six steps plus 3 extra traffic PRs that land in ATC order **without rebasing**, about 60 s
  (run for every PR on 2026-10-14/15; last `shop-261014221127`).
- **Landing reliability (#1, #3, #5, 2026-10-11):** the land check pins the fork head ATC checked and retries if the fork moved;
  the landing lock is token-owned and outlives the checker timeout; every pair of open PRs must have a speculative-merge result
  for their **current** heads before either is cleared or lands (missing or stale pairs are re-queued by the reconcile alarm,
  by a stale result, and by a land request). Only results for both current heads are recorded; a pair check that keeps
  failing is retried (up to 3 attempts, 30 s apart) and only then recorded as final `error` with a `check_failed` signal,
  so a transient error can't clear a PR and a broken checker can't block landing. Gate and pair decisions are pure
  functions in `landing.ts` (2026-10-14, #5). ADR-0018.
  Unit tests in `worker/test/{guard,landing,atc}.test.ts`.
- **No PR stays pending (#2, ADR-0021, 2026-10-14):** any main move (outside ATC too) re-checks every open PR; a check
  pipeline that fails for good shows as an error (STANDBY "ATC couldn't run the checks", `check_failed` signal); the
  reconcile alarm restarts errored (30 s) or 20-min-stuck checks up to 3 times per head. Unit tests in `worker/test/stuck.test.ts`.
- **baseline_head never moves backwards (#4, 2026-10-14):** only a push to main, a land request and a landing set it; an index
  applied late no longer rewinds it or clears a newer go-around. First Coordinator DO tests, in Node on node:sqlite
  (`worker/test/coordinator.test.ts`, ADR-0022).
- **Clearance wording (#6, 2026-10-14):** HOLD says "fix it now to avoid a go-around" (not "then rebase"); FOLLOW names the PRs
  that wait for it instead of "No conflicts" when it has some; MCP descriptions and the agent protocol match. ADR-0015.
- **Queue consumer (#7, 2026-10-14):** each push event is acked or retried on its own with a back-off; poison messages go
  to the `agentmesh-push-events-dlq` dead-letter queue after 3 tries. ADR-0002.
- **Checker concurrency (#8, 2026-10-14):** a cross-process git lock in the container, atomic cache writes, and environment
  failures are no longer cached. `check.ts` is tested locally against temp git repos (`worker/test/container.test.ts`). ADR-0013.
- **Checks share work (#9, 2026-10-14):** a push's checks share one container, re-checks after a landing run in the landing
  container, and per-tree locks make concurrent checks reuse one tsc run. Main's TypeScript state built 7–8× per 5-PR run
  (was 12–14×). Checks now record their wall time (`total`); `run.sh` prints builds and pair-check time. ADR-0013.
- **Tests (#11, 2026-10-14):** `pnpm test` at the root runs everything. Coordinator DO tests now cover the land path (fake checker),
  `onLanded`'s go-around split is a pure function (`afterLanding`), and `check.ts` is tested for a textual conflict and land
  mode (lands onto main, refuses a stale head, refuses a main conflict). ADR-0022.
- **One-command deploy (#18, ADR-0025, 2026-10-14):** `pnpm setup:cloudflare` creates the queues and Artifacts namespace if missing,
  points `wrangler.jsonc` at the account, generates the API key, deploys with secrets and writes `.env` for `run.sh`.
  Idempotent; `--dry-run` shows the plan. Run against this account; untested on a second account.
- **Tidy-up (#10, 2026-10-14):** storage is pruned in the reconcile alarm (never the public replay or the video's run), webhooks
  have a 5 s timeout and one retry, `check_main_conflict` replaces the parsed "on main:" prefix (existing DOs migrate in
  place), duplicates removed. ADR-0024. The read side and signal store were split out of `coordinator.ts` in #42.
- **Competing attempts (#19, ADR-0026, 2026-10-15):** PRs naming the same `task` in `declare_intent` compete. Once all are
  checked, ATC ships the best (green > fewer conflicts > fewer breaking/changed exported symbols > fewer files > smaller diff
  > earlier); the others get STAND DOWN with the reason, a signal, and a refused landing. A person can override (`POST /choose`,
  dashboard PICK). The winner's git note has `ATC-Chosen-Over`. If the attempt that ships goes quiet for `stallSeconds`
  (default 15 min), the next one gets the task (#48). `./demo/run.sh --attempts --browser` passes against production
  (PICK clicked in headless Chromium).
- **Review gate (#16, ADR-0023, 2026-10-14):** optional (off by default). PRs wait in REVIEW until a reviewer approves their
  current head, through the MCP `review` tool, the dashboard's APPROVE button or `POST /reviews`; the note goes into the
  flight log. `./demo/run.sh --review` runs it with a scripted reviewer.
- **Flight log on main (#15, ADR-0019, 2026-10-11):** each landing attaches the PR's story (intent, signals, every clearance
  change with its reason, go-arounds) to the landed commit as a git note under `refs/notes/atc`. `run.sh` step 8 checks every
  landed PR has it (`shop-261011185716`). Agents read it with `get_history` (MCP) or `GET /history`; on the dashboard, click a parked plane.
- **Savings in numbers (#17, ADR-0019):** computed from the event log; `run.sh` prints
  `5 PRs · 10 pairs checked · 1 conflict found in 8 s · 1 rebase (naive: 10)` and the dashboard has a SAVINGS panel.
- **Merge-queue landing (ADR-0015):** ATC merges each PR onto the current main, typechecks that exact commit, and pushes. After a landing,
  only conflicting PRs go around; the rest are re-checked automatically.
- **Real agents, concurrently:** two real Claude Code agents (colliding tasks) both landed with no human help; one was sent around
  and fixed the other's new caller. Main typechecks.
- **ATC:** forks are numbered PRs. ATC computes a landing sequence (CLEARED / FOLLOW / HOLD / GO AROUND / STANDBY) with one reason
  each, which agents read via `get_clearance` (MCP + HTTP) and which the dashboard flies.
- **Real agents:** `demo/src/live.ts` + `agents/` prompts + `handover/02-…`.
- **Live push, recording, replay:** hibernatable WebSocket push on every event (verified: 63 pushes in one run). Snapshots are recorded
  (39 in one run), and `/r/<baseline>?replay` replays them with popups from real events.
- **Outbound webhooks:** HMAC-signed POST per event. **Not verified against a real receiver yet.**
- **Incremental checks (ADR-0013):** persistent repo cache, typecheck results cached by tree hash, main's incremental tsc state.
  In the 5-PR run, 22 of 60 typecheck requests were cache hits.
- **M1 spike:** import (create + `git push`), fork ×2, push with plain git, push event into the Worker. Findings are in DECISIONS.md.
- **M2 in-flight index:** forks through the Artifacts binding, per-fork push subscriptions, a Workflow per push, a tree diff against the true
  merge base (full ancestry), touched files, exported-symbol deltas, imports, file and symbol overlaps. Check: `demo/src/checks/m2-index.ts`.
- **M3 intents and signals:** `declare_intent` returns collisions and notifies others. `get_signals` covers signature changes, overlaps and intent
  overlaps; signals refresh in place and auto-resolve. MCP server with 4 tools. Check: `m3-signals.ts` (agent B is pure MCP).
- **M4 speculative merges:** a `Checker` container runs A alone, B alone, `git merge`, and typechecks the merge. A merge-only failure
  produces `semantic_conflict` to both forks, naming the symbol and the other fork, about 11–21 s after push. Check: `m4-speculative.ts`.
- **M5 landing gate:** current + green gate, closest-to-landing arbitration with ties to the smaller diff, fast-forward landing in the
  container, `rebase_required` to the others. Covered by `run.sh` and `worker/test/landing.test.ts`.
- **Dashboard:** an 8-bit side view at `/r/<baseline>`. PR planes descend a glide slope in ATC order with clouds behind them,
  conflicting planes blink and are linked, planes told to rebase go around into a holding stack, and landings roll out and park.
  Panels: LANDING SEQUENCE and a terse ATC LOG.
- **Repo hygiene:** public GitHub repo `scottfrasso/air-traffic-control`, MIT license, TruffleHog PR secret scan (history scanned
  clean before the first push), 193 tests (`pnpm test`), strict TypeScript in every package.

## Stubbed, simplified, or heuristic (honest list)

- **Symbol extraction is a scanner, not the TS compiler** (ADR-0007). Early `signature_change` and overlap signals are heuristics.
  Semantic-conflict verdicts come only from real `tsc`.
- **Symbol attribution** in a semantic conflict matches the error line against the forks' changed export names. An error
  that doesn't mention a changed symbol is still reported as a conflict, but `symbol` is null.
- **Pair checks are O(n²)** per push across active forks. They run in parallel on a pool of 3 `standard-3` containers, which splits the
  result cache. Routing by fork, or passing ATC's known results into pair checks, would help.
- **Push events vs reconcile:** a new Artifacts subscription takes 30–60 s to start delivering, so a fork's first pushes are
  usually caught by the Coordinator's 5 s reconcile poll (ADR-0006). Both paths are live; the event log shows which one fired.
- **Auth:** one shared API key for every agent and the dashboard (ADR-0005). Agent identity is not authenticated.
- **Go-around fixes are the agent's job.** ATC merges PRs that fit; when one doesn't fit, the agent merges main and fixes it.
- **Competing attempts are found only by an explicit `task` key** (ADR-0026), not by guessing from overlapping intents. Their
  "blast radius" counts changed exported symbols; it doesn't weight them by how many files on main use them (not indexed).
- **Typecheck is the only CI**, by design (prompt.md: no CI beyond typecheck).
- **Alarm-kept DOs run stale code across deploys** (ADR-0009). Mitigated by a 10-minute idle cutoff, fresh baselines per run, and teardown.

## Cut / not done

- **Stretch:** blast-radius estimation from ticket descriptions and scheduling overlapping tickets. Not started.
- **Recording of the two-real-agent run.** The run happened (2026-10-10, ADR-0015) but wasn't recorded; the video shows a
  summary card instead.
- Cloudflare logo in the dashboard's hero cloud (slot reserved; waiting on the owner's asset).
- An LLM to phrase ATC's reasons: rejected for now. The ordering and reasons are deterministic so the demo is repeatable.

## Next

Done on 2026-10-14/15, one PR at a time (each: independent review until "merge", green CI, deployed and `./demo/run.sh`
passing; production always equal to `main` after a merge):
#24 publish the submission · #25 public replay (#14) · #27, #29 the 60-second cut · #28 pair-check errors (#5) · #30, #31, #35 no PR stays pending,
main never moves backwards (#2, #4) · #32 clearance wording (#6) · #33 queue consumer + DLQ (#7) · #34 checker lock (#8) ·
#36 checks share work (#9) · #37 tests (#11) · #38 review gate (#16) · #39, #41 one-command deploy (#18) ·
#40, #42, #43 tidy-up and the Coordinator split (#10) · #44 docs after submission · #45 competing attempts (#19) · #46 follow-ups, and a land run that throws is a retry · #47 its follow-ups · #48 a quiet winner hands its task over.

Open:
- (#21 finals prep is closed on GitHub, closed 2026-10-14 before this run; reopen it if ATC is selected on 10-16.)
- Ideas left by reviews: per-container cap on concurrent tsc runs (ADR-0013 limits); passing ATC's known "alone"
  results into pair checks; a second-account run of `pnpm setup:cloudflare`.

## Tools

- `demo/src/teardown.ts [--keep <baseline>]` deletes old runs (repos, forks, subscriptions).
- `demo/src/tools/scene.ts [conflict|landed]` + `screenshot.ts <baseline> <out.png>` produce dashboard stills.

## 2026-10-10: submission video
- Done: `video/` (Remotion) renders `video/out/atc.mp4`, 2:57 at 1080p30, with ElevenLabs voice-over: the metaphor
  (PRs are planes, GitHub has no controller), today's go-around (rebase onto main, then land late), then a real
  five-PR run (`booking-261010213346`). In that run all 10 pairs are merged and type checked, only PR1 + PR2 fails,
  and ATC orders PR4 → PR5 → PR2 → PR1 → PR3 by its rules. PR1 holds behind PR2 and fixes the call in flight;
  all five land and nobody rebases. See ADR 0016.
- Rebuild: `pnpm --dir demo exec tsx src/video-run.ts` (optional, for a new run), then `pnpm --dir video voiceover`
  and `pnpm --dir video render`.
- Open: Cloudflare logo for the hero cloud (needs the asset).

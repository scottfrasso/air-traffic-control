# PROGRESS

_Last updated 2026-10-11. Next session: start with [`handover/04-next.md`](handover/04-next.md)._

## Before submitting (found 2026-10-11, see docs/research/competition.md)

- Priority work is tracked in GitHub issues labelled `competition`. P0: #12 public repo, #13 video, #14 public replay, #20 submit.
- **Video must be 5–10 min** (official rules §4). v8 `submission/atc-demo.mp4` (6:52) was **approved 2026-10-11**
  and replaced v7. Re-render only if #15/#17 add something worth showing.
- **Repo must be public** (open-source requirement). `scottfrasso/air-traffic-control` is private and `main` is unpushed.
  Owner's call (2026-10-11): **stay private until more work is done**; go public by 10-13 after a full-history secret scan.
- A human fills in the form (automated entry is prohibited). Answers are drafted in `submission/FORM_DRAFT.md`.
- A public read-only replay URL for judges is still TODO (it goes in the form's run instructions).

## Blocked

Nothing.
- Workers Paid is active. The Worker's Queues-only subscription token is installed (`CLOUDFLARE_AGENTMESH_WORKER_API_KEY` → secret `CF_API_TOKEN`).
- Heads-up: the main `CLOUDFLARE_API_TOKEN` (used by seed/teardown) expires **2026-10-15 21:59 UTC**, one day after the deadline.

## Works (verified against deployed Cloudflare resources)

- **Acceptance test:** `./demo/run.sh` passes end to end, all six steps plus 3 extra traffic PRs that land in ATC order **without rebasing**, about 60 s
  (last run 2026-10-11, `shop-261011102223`, after the landing-reliability fixes).
- **Landing reliability (#1, #3, #5, 2026-10-11):** the land check pins the fork head ATC checked and retries if the fork moved;
  the landing lock is token-owned and outlives the checker timeout; every pair of open PRs must have a speculative-merge result
  for their **current** heads before either is cleared or lands (missing or stale pairs are re-queued by the reconcile alarm,
  by a stale result, and by a land request). Only results for both current heads are recorded; a pair check that keeps
  failing is retried (up to 3 attempts, 30 s apart) and only then recorded as final `error` with a `check_failed` signal,
  so a transient error can't clear a PR and a broken checker can't block landing. Gate and pair decisions are pure
  functions in `landing.ts` (2026-10-14, #5). ADR-0018.
  Unit tests in `worker/test/{guard,landing,atc}.test.ts`.
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
- **Repo hygiene:** private GitHub repo `scottfrasso/air-traffic-control`, MIT license, TruffleHog PR secret scan (history scanned
  clean before the first push), 62 unit tests, strict TypeScript in every package.

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
- **Typecheck is the only CI**, by design (prompt.md: no CI beyond typecheck).
- **Alarm-kept DOs run stale code across deploys** (ADR-0009). Mitigated by a 10-minute idle cutoff, fresh baselines per run, and teardown.

## Cut / not done

- **Stretch:** blast-radius estimation from ticket descriptions and scheduling overlapping tickets. Not started.
- **Recording of the two-real-agent run.** The run happened (2026-10-10, ADR-0015) but wasn't recorded; the video shows a
  summary card instead.
- Cloudflare logo in the dashboard's hero cloud (slot reserved; waiting on the owner's asset).
- An LLM to phrase ATC's reasons: rejected for now. The ordering and reasons are deterministic so the demo is repeatable.

## Next

Full plan with reasons: [`handover/04-next.md`](handover/04-next.md). In short:

1. ~~Landing reliability bugs #1, #3, #5.~~ Done 2026-10-11 (#22).
2. ~~#15 flight log on the landed commit (context preservation), then #17 savings in numbers.~~ Done 2026-10-11 (#23);
   still to do: a 10–15 s flight-log beat and a recap with the real numbers in the video.
3. ~~#14 public read-only replay link.~~ Done 2026-10-14 (ADR-0020): https://agentmesh.scottfrasso.workers.dev/r/shop-261011185716?replay
4. If time: #18 one-command deploy, #16 review clearance.
5. Video is approved (#13). Optional: re-render with a #15/#17 beat in place of the recap's "next" line.
6. Secret scan, push, go public (#12) when the owner says so; the owner submits the form (#20) by 10-14 23:59 PDT.

Other code-review follow-ups (#2, #4, #6–#11) are not competition-critical.

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

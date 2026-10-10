# PROGRESS

_Last updated 2026-10-10._

## Blocked

Nothing.
- Workers Paid is active. The Worker's Queues-only subscription token is installed (`CLOUDFLARE_AGENTMESH_WORKER_API_KEY` → secret `CF_API_TOKEN`).
- Heads-up: the main `CLOUDFLARE_API_TOKEN` (used by seed/teardown) expires **2026-10-15 21:59 UTC**, one day after the deadline.

## Works (verified against deployed Cloudflare resources)

- **Acceptance test:** `./demo/run.sh` passes end to end, all six steps plus 3 extra traffic PRs that land in ATC order **without rebasing**, about 56 s.
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
  clean before the first push), 16 unit tests, strict TypeScript in every package.

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
- **Second demo variant with two real coding agents over MCP.** The tools are built and exercised by a scripted MCP client
  (`m3-signals.ts`), but there's no recorded run with two LLM agents.
- Cloudflare logo in the dashboard's hero cloud (slot reserved; waiting on the owner's asset).
- An LLM to phrase ATC's reasons: rejected for now. The ordering and reasons are deterministic so the demo is repeatable.

## Next

1. Make the video: see `handover/03-video.md` (Remotion + ElevenLabs; footage from `demo/src/tools/record-replay.ts`).
2. Optional: logo asset in the hero cloud; route checks by fork to raise the cache hit rate.

## Tools

- `demo/src/teardown.ts [--keep <baseline>]` deletes old runs (repos, forks, subscriptions).
- `demo/src/tools/scene.ts [conflict|landed]` + `screenshot.ts <baseline> <out.png>` produce dashboard stills.

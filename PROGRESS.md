# PROGRESS

_Last updated 2026-10-10._

## Blocked

Nothing.
- Workers Paid is active. The Worker's Queues-only subscription token is installed (`CLOUDFLARE_AGENTMESH_WORKER_API_KEY` → secret `CF_API_TOKEN`).
- Heads-up: the main `CLOUDFLARE_API_TOKEN` (used by seed/teardown) expires **2026-10-15 21:59 UTC**, one day after the deadline.

## Works (verified against deployed Cloudflare resources)

- **Acceptance test:** `./demo/run.sh` passes end to end, all six steps, about 40 s, on 3 consecutive runs.
- **M1 spike:** import (create + `git push`), fork ×2, push with plain git, push event into the Worker. Findings are in DECISIONS.md.
- **M2 in-flight index:** forks through the Artifacts binding, per-fork push subscriptions, a Workflow per push, a tree diff against the true
  merge base (full ancestry), touched files, exported-symbol deltas, imports, file and symbol overlaps. Check: `demo/src/checks/m2-index.ts`.
- **M3 intents and signals:** `declare_intent` returns collisions and notifies others. `get_signals` covers signature changes, overlaps and intent
  overlaps; signals refresh in place and auto-resolve. MCP server with 4 tools. Check: `m3-signals.ts` (agent B is pure MCP).
- **M4 speculative merges:** a `Checker` container runs A alone, B alone, `git merge`, and typechecks the merge. A merge-only failure
  produces `semantic_conflict` to both forks, naming the symbol and the other fork, about 11–21 s after push. Check: `m4-speculative.ts`.
- **M5 landing gate:** current + green gate, closest-to-landing arbitration with ties to the smaller diff, fast-forward landing in the
  container, `rebase_required` to the others. Covered by `run.sh` and `worker/test/landing.test.ts`.
- **Dashboard:** an 8-bit top-down runway at `/r/<baseline>`. Planes approach in landing order, conflicts blink and link,
  rebase-required planes hold, and landings roll out to the apron. Includes a flight board and tower radio.
- **Repo hygiene:** private GitHub repo `scottfrasso/air-traffic-control`, MIT license, TruffleHog PR secret scan (history scanned
  clean before the first push), 16 unit tests, strict TypeScript in every package.

## Stubbed, simplified, or heuristic (honest list)

- **Symbol extraction is a scanner, not the TS compiler** (ADR-0007). Early `signature_change` and overlap signals are heuristics.
  Semantic-conflict verdicts come only from real `tsc`.
- **Symbol attribution** in a semantic conflict matches the error line against the forks' changed export names. An error
  that doesn't mention a changed symbol is still reported as a conflict, but `symbol` is null.
- **Pair checks are O(n²)** per push across active forks. That's fine for a handful of agents but not tuned for dozens.
- **Push events vs reconcile:** a new Artifacts subscription takes 30–60 s to start delivering, so a fork's first pushes are
  usually caught by the Coordinator's 5 s reconcile poll (ADR-0006). Both paths are live; the event log shows which one fired.
- **Auth:** one shared API key for every agent and the dashboard (ADR-0005). Agent identity is not authenticated.
- **Landing is fast-forward only.** Agents merge or rebase baseline themselves (the demo's agent B merges).
- **Typecheck is the only CI**, by design (prompt.md: no CI beyond typecheck).
- **Alarm-kept DOs run stale code across deploys** (ADR-0009). Mitigated by a 10-minute idle cutoff, fresh baselines per run, and teardown.

## Cut / not done

- **Stretch:** blast-radius estimation from ticket descriptions and scheduling overlapping tickets. Not started.
- **Second demo variant with two real coding agents over MCP.** The tools are built and exercised by a scripted MCP client
  (`m3-signals.ts`), but there's no recorded run with two LLM agents.
- Cloudflare logo in the dashboard's hero cloud (slot reserved; waiting on the owner's asset).
- The dashboard polls every second instead of using WebSockets (ADR-0008).

## Next

1. Record the video per DEMO_SCRIPT.md.
2. Optional: two-real-agent MCP variant; logo asset in the hero cloud.

## Tools

- `demo/src/teardown.ts [--keep <baseline>]` deletes old runs (repos, forks, subscriptions).
- `demo/src/tools/scene.ts [conflict|landed]` + `screenshot.ts <baseline> <out.png>` produce dashboard stills.

# ADR-0014: Live push to dashboards, recorded replay, outbound webhooks, real agents

- Status: Accepted (supersedes the polling part of ADR-0008)
- Date: 2026-10-10

## Decision
- **Live push:** every Coordinator event schedules a 120 ms debounced flush that broadcasts the full state to dashboards
  connected through `GET /api/repos/:b/live` (a hibernatable WebSocket, authorized by `?key=`). The dashboard falls back to
  polling only while reconnecting. Browsers can't receive HTTP webhooks, so this is the "webhooks to the dashboard" channel.
- **Outbound webhooks:** `POST /api/repos/:b/webhooks {url, secret?}` (https only). Every event is POSTed as
  `{type: "atc.event", baseline, event}`, with `x-atc-signature: sha256=<HMAC>` when a secret is set.
- **Recording:** each flush also stores a compact snapshot (forks, sequence, open conflict and rebase signals), but only when it differs
  from the last one. `GET /timeline` returns all snapshots plus all events.
  Since ADR-0019 a snapshot also carries the run's savings, and the timeline carries the landed PRs' flight logs once.
- **Replay:** `/r/<baseline>?replay` plays the recording through the same renderer, with idle gaps compressed to 2.5 s and speeds
  1x/2x/4x/8x, plus pause and restart. Event popups (PUSH, CONFLICT!, LANDED, REBASE…) come from the real recorded events.
- **Real agents:** `start_work` returns ready-to-run git commands (with tokens) and a short protocol. `demo/src/live.ts` seeds a
  runway and writes per-agent prompts from `agents/PROTOCOL.md` + `agents/tasks.json`.

## Evidence
- During a 5-PR demo run, a WebSocket listener received 63 pushes covering every event kind. 39 snapshots and 95 events were recorded.
- One headless Claude Code agent (`claude -p`, MCP via `--mcp-config`) ran start_work → clone → declare_intent → implement →
  typecheck → push → request_land (retry) → **landed**, with no human help.
- Not yet verified end to end: delivery to an external webhook receiver (the code path exists, but there's no test receiver).

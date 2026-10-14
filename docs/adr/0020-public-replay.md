# ADR-0020: Key-less read-only replay of allow-listed recorded runs

- Status: Accepted. Narrows ADR-0005 (one API key guards every route) for a single read route.
- Date: 2026-10-14. Issue #14.

## Context
Judges give 25% to ease of use (ADR-0017), and until now they could see nothing without our API key or their own
Cloudflare account. The dashboard shell at `/r/<baseline>` was already public, but every data route needed the key.

## Decision
- `GET`/`HEAD /api/repos/<baseline>/timeline` is served **without a key** when `<baseline>` is listed in the
  comma-separated var `PUBLIC_REPLAY_BASELINES` (`worker/wrangler.jsonc`). Today that's `shop-261011185716`.
  The check (`publicReplayBaseline`, `worker/src/public.ts`) runs before the key check in `worker/src/index.ts` and
  matches that exact path only: no other method or route, and not `/state` or `/live`, so no WebSocket.
- The response is the recorded timeline (ADR-0014): compact snapshots, the event log and flight logs. None of these
  hold tokens or remotes; fork and baseline tokens are returned only by `POST /forks` and never stored in snapshots.
  It's cached for 60 s (`cache-control: public, max-age=60`).
- The public route reads the Coordinator directly and does not call `ensure`, so it never writes to the Durable Object.
- In replay mode (`?replay`) the dashboard fetches the timeline without a key first and asks for one only on 401.
  With no key it hides "Back to live", because live mode still needs the key.
- Public link: `https://agentmesh.scottfrasso.workers.dev/r/shop-261011185716?replay`.

## Consequences
- Anyone can read the allow-listed run's PR names, symbols and timings. Keep only demo baselines on the list, and
  don't delete them while the link is published (the README and the competition form point to it).
- Everything that writes (forks, intents, land, webhooks, reconcile, MCP) and the live socket still need the key.
  Without it they return 401, which was checked on the deployed Worker.
- An unlisted baseline's timeline still returns 401, so a guessed baseline name reveals nothing.

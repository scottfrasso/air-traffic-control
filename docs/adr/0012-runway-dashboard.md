# ADR-0012: 8-bit top-down runway dashboard (supersedes the strip-bay design)

- Status: Accepted
- Date: 2026-10-10
- Supersedes: the visual part of ADR-0008. Polling stays.

## Context
The owner asked for a retro, 8-bit air-traffic-control look from above a runway. Agents are planes, the plane closest to the
runway lands next, and clouds are mandatory (Cloudflare hackathon), with space for the Cloudflare logo later.

## Decision
- A canvas rendered at 384×216 logical pixels and scaled with `image-rendering: pixelated`. Fonts: Press Start 2P (pixel labels) and VT323 (panel).
- **Approach order = landing order.** The Coordinator exposes `approach` (`src/landing.ts` `approachQueue`, the same ranking the
  landing gate uses). Slot 0 sits on short final.
- Story beats: semantic or textual conflict gives a blinking red box on both planes and a dashed red link. `rebase_required` or
  `land_blocked` sends the plane to a holding oval. Landing plays touchdown, roll-out, taxi and park on the apron. A green light means it typechecks.
- Clouds drift and cast shadows. A large fixed cloud top-right is the reserved Cloudflare-logo slot.
- Side panel: FLIGHT BOARD (status / check / diff) and TOWER RADIO, where signals become tower transmissions and fork names become callsigns.
- `prefers-reduced-motion` freezes drift and orbit and snaps planes to position.

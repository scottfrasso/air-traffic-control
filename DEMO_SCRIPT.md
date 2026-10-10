# Demo video script (2:30)

The video is built around `./demo/run.sh`. Record two windows side by side: **left**, the terminal running `run.sh`;
**right**, the runway dashboard at the `/r/<baseline>` link the script prints. Use a fresh run with the key already
stored in the browser.

Tip: start `run.sh`, copy the dashboard link from its second line, and the dashboard fills in as agents fork.

| # | Time | Shot | Voice-over / on-screen text |
| --- | --- | --- | --- |
| 1 | 0:00–0:12 | Title card over the empty runway (clouds drifting). | "Ten coding agents, one repo. GitHub tells you they collided at merge time. We tell them while they're still flying." |
| 2 | 0:12–0:25 | Terminal: `./demo/run.sh`. Step 1 scrolls: agent A forks, changes `applyDiscount(price, percent)` → `applyDiscount(price, discount)`. Dashboard: plane **A** enters approach. | "Every agent gets its own fork in Cloudflare Artifacts, a real Git repo created in about two seconds." |
| 3 | 0:25–0:40 | Step 2: agent B forks and adds `checkout.ts` calling `applyDiscount(price, 15)`. Plane **B** appears. Tower radio shows the early `signature_change` note to B. | "B adds a new caller in a different file. Before any check runs, B is told that A is changing the signature of a function B uses." |
| 4 | 0:40–0:55 | Step 3: **PASS: plain git merge … clean, no conflicts.** Zoom on that line. | "Plain git sees nothing wrong. The two forks touch different files." |
| 5 | 0:55–1:20 | Step 4: both planes **blink red**, dashed red link between them. Flight board: CONFLICT / GREEN / GREEN. Radio: "Speculative merge … fails typecheck: src/checkout.ts:6 TS2345 … Neither fork fails alone." | "On every push, a Workflow merges each pair of in-flight forks in a container and runs the typechecker. A failure neither fork has alone is a semantic conflict, and both agents hear about it about 15 seconds after the push, before anyone asks to land." |
| 6 | 1:20–1:35 | Point at the approach order (B on short final, A behind) and the DIFF column. | "Approach order is landing order: closest to landing wins, ties go to whoever is cheaper to rebase." |
| 7 | 1:35–1:55 | Step 5: A requests landing. Plane **A** touches down, rolls out, taxis to the apron. Plane **B** peels off into the **holding pattern**. Radio: "A landed … rebase onto baseline main and fix." Terminal: B's early landing is refused. | "A asks to land, and it's current and green, so it lands. B is sent to hold: rebase required, with the exact symbol and error." |
| 8 | 1:55–2:15 | B merges baseline, fixes the call, pushes. Plane B rejoins approach, goes green, lands, and parks next to A. | "B rebases, fixes one line, and lands." |
| 9 | 2:15–2:25 | Step 6: **PASS: tsc --noEmit on baseline**, `git log` on baseline, **DEMO PASSED**. | "Baseline typechecks. No broken main, no merge-time surprise." |
| 10 | 2:25–2:30 | Architecture diagram from the README: Artifacts → Queues → Durable Object → Workflow → Container, plus MCP. | "Workers, Artifacts, Durable Objects, Workflows, Sandbox containers and an MCP server, all on Cloudflare." |

## Pre-flight checklist
- `pnpm exec tsx demo/src/teardown.ts` so old planes don't clutter anything (each run uses a fresh baseline anyway).
- Run `./demo/run.sh` once off-camera to warm the checker container. The first run after a deploy is about 5 s slower.
- Browser at 1440 px wide or more. Dashboard key saved (open any `/r/...` link once).
- If you show MCP: `demo/src/checks/m3-signals.ts` drives agent B entirely through `/mcp`.

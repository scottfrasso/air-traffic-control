# Demo video script (2:30)

Record from **replay**, so every frame is a real recorded run. Do a fresh `./demo/run.sh`, then open
`<dashboard>/r/<baseline>?replay` at 2x and screen-record the browser (1440 px or wider). Optionally put the terminal
output of the same run side by side, using the timestamps in the ATC LOG to line them up.

| # | Time | Shot | Voice-over / on-screen text |
| --- | --- | --- | --- |
| 1 | 0:00–0:10 | Empty sky, clouds drifting, runway on the right. Title: **ATC: Air Traffic Control for coding agents**. | "Five coding agents, one repo. GitHub tells you they collided at merge time. ATC tells them while they're still in the air." |
| 2 | 0:10–0:25 | PR1 and PR2 appear ("NEW PR", then "PUSH" popups). Terminal: PR1 changes `applyDiscount(price, percent)` → `(price, discount)`; PR2 adds `checkout.ts` calling `applyDiscount(price, 15)`. | "Every PR is its own fork in Cloudflare Artifacts, a real Git repo. Agents just push." |
| 3 | 0:25–0:35 | PR3–PR5 join the approach (independent work). | "More traffic: shipping, docs, formatting. None of it collides." |
| 4 | 0:35–0:45 | Terminal: **PASS: plain git merge … clean, no conflicts.** | "Plain git sees nothing wrong. Different files." |
| 5 | 0:45–1:10 | "CONFLICT!" pops over PR1 and PR2, red dashed link, both blinking. LANDING SEQUENCE: **#1 PR2 CLEARED: beats PR1 on applyDiscount, smaller diff** / **PR1 HOLD: lands after PR2**. | "On every push, a Workflow merges each pair of PRs in a container and runs the typechecker, reusing main's results so only the deltas are checked. A failure neither PR has alone is a semantic conflict. Both agents hear about it within seconds, before anyone asks to land." |
| 6 | 1:10–1:25 | Point at the sequence board: CLEARED / FOLLOW / HOLD with one reason each. | "ATC gives every PR one clearance and one reason. Agents ask ATC with get_clearance. Nobody guesses." |
| 7 | 1:25–1:45 | PR1 requests landing ("REQ LAND"), touches down ("LANDED"), rolls out and parks. Only PR2 shows "REBASE" and goes around. PR3–PR5 stay on approach (STANDBY "re-checking on the new main", then FOLLOW). | "PR1 asks to land first, and it fits on main, so ATC merges it. Only PR2 actually conflicts, so only PR2 goes around, with the exact symbol and error. Everyone else just stays in line: ATC re-checks them on the new main. No rebases." |
| 8 | 1:45–2:10 | PR2 pushes its fix and lands. PR3–PR5 land one by one ("Land PRn via ATC"). "Landed: PR1, PR2, …". | "PR2 fixes one line and lands. The rest land in sequence, merged by ATC: a merge queue that knows about semantics." |
| 9 | 2:10–2:20 | Terminal: **PASS tsc --noEmit on baseline**, **DEMO PASSED**. | "Main stays green. No merge-time surprises." |
| 10 | 2:20–2:30 | README architecture diagram, plus a clip of real Claude Code sessions calling `start_work` and `request_land`. | "Workers, Artifacts, Durable Objects, Workflows, Sandbox containers and MCP, and it works with real Claude Code agents today." |

## Pre-flight
- Run `pnpm exec tsx demo/src/teardown.ts`, then run `./demo/run.sh` once off-camera to warm the checker containers.
- For the real-agent clip, follow `handover/02-run-real-claude-code-agents.md` and record its replay the same way.

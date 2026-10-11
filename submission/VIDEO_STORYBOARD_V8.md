# Video v8 storyboard (target 7:00; rules require 5–10 min)

The v7 cut (2:57) is **too short for the rules** and jumps straight into the airport, so it never shows the problem.
v8 follows the classic three parts:

1. **Tell them what you're going to tell them:** hook plus a 3-item agenda.
2. **Tell them:** the problem (new graphics), the idea (airport mapping), the demo (existing replay), how it's built.
3. **Tell them what you told them:** recap the same 3 items with proof, then close.

The **three things** repeat at every stage and give the video its spine:
**① See everyone's work in flight · ② Warn about collisions early · ③ Decide who lands next.**
They appear as three numbered chips: on the agenda card, as section badges during the demo, and as checkmarks in the recap.

Narration style: plain and generic, no code symbol names. Say "a function's inputs" and "a new use of it in another file".
Always explain "go around" as "rebase on the new main, then land."

---

## Part 1: Tell them what you'll tell them (0:00–0:50)

| # | Time | Visual | Voice-over |
| --- | --- | --- | --- |
| 1 | 0:00–0:15 | Black → title card: **ATC: Air Traffic Control for coding agents** · "Built on Cloudflare". Clouds drift in. | "Coding agents can now write code in parallel, many of them on one repo at once. Our tools still assume a few people taking turns." |
| 2 | 0:15–0:35 | **Agenda card.** Three chips fade in one by one: ① See everyone's work in flight ② Warn about collisions early ③ Decide who lands next. | "ATC is a coordination layer for many agents on one repo. In the next few minutes I'll show you the problem, then the three things ATC does about it: it sees everyone's work while it's in flight, it warns agents about collisions early, and it decides who lands next." |
| 3 | 0:35–0:50 | Small roadmap bar across the top: **Problem → Idea → Demo → How it's built → Recap**. The current section lights up for the rest of the video. | "Then a live run on Cloudflare, how it's built, and a quick recap." |

## Part 2a: The problem (0:50–2:10). **New graphics, before the airport**

Flat 8-bit style that matches the dashboard: same palette, same pixel font. The airport doesn't appear yet.

| # | Time | Visual (new graphic) | Voice-over |
| --- | --- | --- | --- |
| 4 | 0:50–1:10 | **G1 "Branches fan out."** A horizontal main line. One branch comes off it and merges back: fine. Then 5, then 20 branches fan out at once, each with a small robot icon. The counter reads "agents: 1 → 5 → 20". | "With one developer, you branch, work, and merge. With twenty agents, twenty branches are open at the same time, all built on the same starting point." |
| 5 | 1:10–1:35 | **G2 "Found too late."** Timeline with two lanes, Agent A and Agent B. Each fills a progress bar ("1 hour of work"). Both arrive at a MERGE gate at the end and it flashes red: "conflict". Both bars turn grey: "wasted". | "Today, a collision shows up at merge time, after both pieces of work are done. By then one of them has to be redone." |
| 6 | 1:35–1:55 | **G3 "Merges clean, breaks anyway."** Two file cards side by side. Left: "changes a function's inputs" with a ✓ "passes alone". Right: "adds a new use of that function" with a ✓ "passes alone". Git badge: **"no conflict"** in green. The two cards slide together, and a red ✗ appears: "doesn't build". | "The worst kind is invisible to git. One agent changes what a function expects. Another, in a different file, starts using it the old way. Each passes on its own. Git merges them with no conflict. Together, the code doesn't build." |
| 7 | 1:55–2:10 | **G4 "Rebase storm."** A main line with many branches. Every time main moves, every branch flashes "rebase". A small curve on the right climbs steeply: "possible collisions grow with every pair of agents". | "And every time main moves, every agent is told to rebase, even the ones that never touched the same thing. The work grows with every pair of agents." |
| 8 | 2:10–2:20 | **Question card:** "What if agents heard about collisions *while still working*, and something decided the landing order?" | "So what if agents heard about collisions while they were still working, and something decided who lands next?" |

## Part 2b: The idea, mapped onto an airport (2:20–3:00)

| # | Time | Visual | Voice-over |
| --- | --- | --- | --- |
| 9 | 2:20–2:45 | **G5 "The mapping."** Each item morphs into its airport counterpart, left to right: a branch becomes a plane; main becomes the runway; ATC becomes the control tower. Labels: *each agent's change = a plane · main = the runway · ATC = the tower*. | "That's an air traffic control problem. Each agent's change is a plane. Main is the runway. ATC is the tower: it watches every plane, warns about collisions, and gives landing clearances." |
| 10 | 2:45–3:00 | **G6 "Clearances."** Five pixel cards: CLEARED · FOLLOW · HOLD · GO AROUND · STANDBY, each with a one-line meaning. GO AROUND reads "rebase on the new main, then land". | "Every plane gets one clearance with one reason. Cleared to land. Follow the plane ahead. Hold. Go around, which means rebase on the new main, then land. Or stand by while checks run." |

## Part 2c: The demo, a real recorded run (3:00–5:30)

Reuse the v7 replay beats, slowed down, with a **chip badge (①/②/③) in the corner** marking which promise is being shown.
Keep the "PR" names on screen; they're needed to follow along.

| # | Time | Badge | Visual | Voice-over |
| --- | --- | --- | --- | --- |
| 11 | 3:00–3:25 | ① | PR1 and PR2 appear, with NEW PR and PUSH popups. Side panel: each PR is its own fork in Artifacts. | "Here's a real run on Cloudflare. Five agents, each working in its own fork of the repo. They just use git and push." |
| 12 | 3:25–3:45 | ① | PR3–PR5 join. Callout boxes show the files each PR touches. | "On every push, ATC reads what changed: which files and which functions. So it always knows what's in flight." |
| 13 | 3:45–4:00 | ② | Terminal overlay: "plain git merge: clean, no conflicts". | "Two of these changes are exactly the invisible collision from before. Git sees nothing wrong." |
| 14 | 4:00–4:30 | ② | CONFLICT! over PR1 and PR2 with a red link. A small inset animates the check: "merge the pair → run the type checker → fails only together". Timer callout: "~10–15 s after the push". | "But on every push, ATC test-merges each pair of changes and runs the type checker. This pair only fails together, so within seconds both agents are told who they collide with, and why. Nobody has asked to land yet." |
| 15 | 4:30–4:50 | ③ | LANDING SEQUENCE panel, enlarged. One reason per PR. | "ATC also keeps the landing order. Whoever is closest to landing goes first. On a tie, the smaller change wins, because it's cheaper to redo." |
| 16 | 4:50–5:15 | ③ | PR1 lands. Only PR2 goes around (popup: "go around = rebase on the new main"). PR3–PR5 stay on approach: STANDBY, then FOLLOW. | "The first one lands. Only the one that really collides goes around: it rebases on the new main. The other three aren't touched. ATC re-checks them for them, and they keep their place in line." |
| 17 | 5:15–5:30 | ③ | PR2 lands, then PR3–PR5 land one by one. Terminal: "main typechecks ✓ · DEMO PASSED". | "The fixed change lands, then the rest, in order. Main is green at the end." |
| 18 | 5:30–5:55 | ①②③ | **Real agents clip:** two Claude Code terminals side by side, plus the dashboard. One gets the collision signal, one lands, the other goes around and fixes it. | "This isn't just scripts. Two real Claude Code agents with colliding tasks connected through ATC's MCP server. One landed. The other was told to go around, fixed the collision itself, and landed. No human stepped in." |

## Part 2d: How it's built on Cloudflare (5:55–6:30)

| # | Time | Visual | Voice-over |
| --- | --- | --- | --- |
| 19 | 5:55–6:30 | **G7 "One push, end to end."** The v6 numbered product cards, now drawn as a flow: agent `git push` → **Artifacts** fork → push **event** → **Queue** → **Worker** → **Durable Object** (the tower) → **Workflow** → **Container** (merge + type check) → signal back to agent via **MCP**. Each card lights up as the push travels. | "Under the hood it's all Cloudflare. Artifacts stores the repo and gives every agent its own fork. Every push fires an event. A Durable Object is the tower: one place per repo that knows everything in flight and decides the order. A Workflow runs the checks for each push, inside containers. And agents talk to it through an MCP server on a Worker." |

## Part 3: Tell them what you told them (6:30–7:10)

| # | Time | Visual | Voice-over |
| --- | --- | --- | --- |
| 20 | 6:30–6:55 | **Recap card**, the agenda card again, each chip getting a ✓ and a proof line: ① "every push indexed" ② "collision flagged in ~10–15 s, before anyone asked to land" ③ "only the colliding change rebased; 3 others landed with zero rebases". | "So, three things. ATC sees everyone's work while it's in flight. It warns about collisions early, even ones git can't see. And it decides who lands next, so only real collisions cost a rebase." |
| 21 | 6:55–7:10 | Runway at dusk, all planes parked, clouds drifting. "ATC · Built on Cloudflare · github.com/scottfrasso/air-traffic-control". | "Many agents, one repo, no merge-day surprises. That's ATC, built on Cloudflare." |

---

## Production notes

- **New graphics to build in Remotion:** G1–G7, the agenda/recap card and the roadmap bar. They are pure Remotion
  components (no recorded data), so they're quick to iterate on. G3 and G6 matter most; they carry the "what's the problem" message.
- **Pacing:** v7 rushed. At about 150 wpm the VO above runs about 6:30, leaving pauses on graphics. Don't pad it: the floor is 5:00.
- **Avoid:** naming GitHub negatively (the rules forbid attacks on products), code symbol names in VO, unmeasured numbers.
- **Optional, if time allows:** a 15 s beat after #17 showing the "why" note on the landed commit (intent, signals,
  clearance history) if the context-preservation feature gets built. It answers the 25% "context preservation / review" criterion.
- **Live finals (10 min on stage):** the same structure works. The live demo replaces the replay, and the graphics become slides.

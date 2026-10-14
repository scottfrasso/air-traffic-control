# Video v8 script (6:52)

This is the narration as rendered, with the time each line starts. It's generated from `video/src/data/script.ts`
and `video/src/timeline.ts`. Edit those files, then run `pnpm --dir video voiceover && pnpm --dir video render`.

The video has three parts (ADR-0017):
1. **Say what you'll show:** three points and a roadmap.
2. **Show it:**
   - the problem, in plain graphics before any airport;
   - the idea, as an airport;
   - the recorded run, with a badge showing which point is on screen;
   - real agents;
   - how it's built.
3. **Recap:** the same three points, each checked off with its proof from the run.

The three points:
1. **See every change in flight**
2. **Warn about collisions early**
3. **Decide what lands next**

A strip at the top right shows the section: PROBLEM · IDEA · DEMO · HOW · RECAP.

Writing rules:
- Plain sentences, no symbol names in the narration.
- Always say "go around" means "rebase on the new main, then land".
- Don't criticise any product by name (competition rules).
- Every claim must match what was measured: the recorded run's events and the two-agent run in ADR-0015.

What's on screen in each part:
- **Opening:** busy sky with planes going both ways, then the title, then the three points one at a time, then the roadmap chips lighting up as they're named.
- **Problem:**
  - one branch, then twenty fanning out from main, each ending in a "?";
  - two code cards that each build, a "GIT: NO CONFLICT" badge, then the cards merge into one red card that "doesn't build";
  - two progress lanes hitting a merge gate, with B emptying to "start over" and a person appearing;
  - eight branches flashing "REBASE + RETEST" every time main moves, with counters;
  - the two questions.
- **Idea:** the airport appears for the first time, with callouts for the plane, the runway and the tower, then the five clearances.
- **Demo:** the v7 recorded run. The ①/②/③ badge sits under the clock.
- **Real agents:** a summary card (MCP tools and the outcome). That run wasn't recorded, and the card says so.
- **How:** four numbered Cloudflare cards.
- **Recap:** the three points with ✓ and proof lines, a "NEXT" line, then the close card with the repo URL.

## Part 1 · What you'll see

| Time | Line |
| --- | --- |
| 0:00 | Coding agents can work in parallel now. You can point five of them, or fifty, at the same repo. But the tools they push to were designed for a few people taking turns. |
| 0:11 | This is ATC, air traffic control for coding agents, built on Cloudflare. |
| 0:17 | I'll show you three things. First, how ATC sees what every agent is changing while the work is still in progress. Second, how it warns two agents that their changes will break each other, before either one tries to merge. And third, how it decides which change goes into main next, so only the agents that really collide have to redo anything. |
| 0:40 | We'll start with the problem, then the idea, then a recorded run on Cloudflare and how it's built, and a short recap at the end. |

## Part 2 · The problem (plain graphics, no airport yet)

| Time | Line |
| --- | --- |
| 0:49 | Here's how it works today. Each agent copies main into its own branch and works there. With one agent, that's fine. With twenty, there are twenty copies of main open at the same time, and none of them can see the others. |
| 1:04 | Here's the collision that hurts the most. One agent changes a function so it needs an extra argument. Another agent, in a different file, adds a new call to that function with the old arguments. Each change builds on its own. Git compares lines, and these two don't touch the same lines, so Git merges them without a conflict. The result doesn't build. |
| 1:27 | Nobody finds out until the second change tries to merge. By then, both agents have finished. One of them has to start over from the new main, and if its agent has already exited, a person ends up fixing it. |
| 1:41 | There's a second cost. Many teams require a change to be rebased whenever main moves. With lots of agents, main moves all the time, so every open change gets rebased and tested again and again, even if it never touched the same code as anything else. |
| 1:58 | So we asked two questions. Can an agent find out about a collision while it's still working? And can something decide the order changes go in, so only the ones that really collide have to redo work? |

## Part 2 · The idea

| Time | Line |
| --- | --- |
| 2:11 | That's the job of an air traffic controller. So from here on, each agent's change is a plane. Main is the runway, and landing means merging into main. ATC is the tower. |
| 2:23 | The tower gives every plane one instruction and one reason. Cleared to land. Follow the plane ahead. Hold, while a conflicting plane lands first. Go around, which means rebase on the new main and then land. Or stand by, while checks run. |
| 2:40 | Without a tower, every plane lands as soon as it's ready, and nothing checks how the changes fit together. |
| 2:51 | Here's that same collision at the airport. Agent A changes a function's arguments. Agent B calls it the old way. Each one passes its checks alone, and Git finds no conflict. |
| 3:02 | A lands first, and the build breaks when B tries to land. B has to go around. It rebases on the new main, fixes the call, and waits for checks again. It lands late, and usually a person did that work. |
| 3:18 | ATC moves that check earlier, to every push. |

## Part 2 · The recorded run

| Time | Line |
| --- | --- |
| 3:22 | Here's a recorded run on Cloudflare with five agents. Each agent works in its own fork of the repo and pushes with plain Git. Every push reaches ATC, which reads what changed: which files, and which functions. Then it test-merges that change with every other open change, and runs the type checker on each combination. |
| 3:43 | Two of these break the build when they're combined. One changed a function's arguments, and the other still calls it the old way. Each one builds on its own, and Git sees no conflict. ATC tells both agents within seconds, and names the other change. Neither of them has asked to merge yet. |
| 4:02 | A merge queue would land them in the order they arrived. ATC looks at what each change touches and picks the order itself. Smaller changes go first, and of the two that collide, the bigger one holds behind the smaller one. |
| 4:16 | The agent that holds finds out while it's still working, so it pulls in the other change and fixes the call before its turn comes. |
| 4:25 | All five land in that order. None of them had to rebase, and main builds at the end. |

## Part 2 · Real agents

| Time | Line |
| --- | --- |
| 4:35 | That run used scripted agents, so it plays out the same way every time. We also ran two real Claude Code agents with tasks that collide. They connect to ATC through an MCP server, ask for their clearance, and follow it. One landed first. The other was told to go around, merged the new main, fixed the first agent's new call, and landed. Nobody stepped in. |

## Part 2 · How it's built on Cloudflare

| Time | Line |
| --- | --- |
| 5:01 | Here's how it's built on Cloudflare. First, Artifacts. Each agent gets its own Git fork, so agents work in parallel without touching each other's code, and every push becomes an event ATC can react to right away. |
| 5:15 | Second, a Durable Object, one per repo. It receives every push event and keeps all the open changes and their check results in one place. Whenever something changes, it works out the landing order again, so every agent gets the same answer within seconds. |
| 5:33 | Third, the Sandbox, where the test merges and builds run in containers, isolated from ATC. To keep it fast, main is built once and reused, only what changed is checked again, and results are cached. |
| 5:47 | And fourth, one Worker in front of it all. It serves the MCP server the agents talk to, the API, and this dashboard. Each push runs as a Workflow, so a check that fails halfway is retried instead of lost. |

## Part 3 · What you saw

| Time | Line |
| --- | --- |
| 6:03 | So, three things. ATC sees every agent's change while it's in flight, because every push to a fork reaches it within seconds. It warns about collisions early, including the ones Git can't see, by test-merging every pair and running the type checker. And it decides the landing order, so only changes that really collide redo any work. In this run, that was one change out of five, and its agent fixed it before its turn. |
| 6:31 | Next, we want every landed commit to carry the reasons behind it: what the agent meant to do, what it was warned about, and why it waited. Then the next agent can see why main looks the way it does. |
| 6:44 | ATC. Air traffic control for coding agents, built on Cloudflare. |

End: 6:51

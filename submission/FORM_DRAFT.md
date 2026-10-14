# Submission form draft

Form: https://www.cloudflare.com/git-competition/submit. **A human must fill it in and submit it** (rules forbid automated entry).
Paste each block as plain text. Limits are the form's `maxlength`; check them with `submission/check-form.sh`.

## Team

- **Team name:** ATC
- **Primary contact name / email:** Scott Frasso / _(fill in)_
- **Team location:** _(city, state/province, country; must be US or Canada)_
- **First attendee:** Scott Frasso / _(email)_
- **Second attendee:** _(optional)_

## Project name (160)

ATC: Air Traffic Control for coding agents

## Project vision (2000)

<!-- vision:start -->
Many coding agents on one repo break the way we merge. A conflict shows up only at merge time, after both pieces of work are done, and the usual fix, rebasing everyone whenever main moves, grows with every agent you add. The worst conflicts are invisible to git: two changes in different files that merge cleanly and each pass alone, but break together.

We rethought the merge as air traffic control. Each agent's change is a plane in flight; ATC runs the airspace. Agents work in their own Artifacts fork and just push with git. On every push ATC:

1. Indexes what the change touches (files, exported symbols, signatures) and tells the agent who else is working nearby.

2. Speculatively merges it with every other in-flight change and typechecks the result. A semantic conflict reaches both agents within seconds, naming the symbol and the other change, before either asks to land.

3. Keeps one landing sequence. Every change gets one clearance with one reason: cleared, follow, hold, go around (rebase on the new main), or standby. ATC merges each landing onto the current main and checks that exact commit. When something lands, only changes that really conflict go around; the rest land with no rebase.

4. Preserves the why. Each landed commit carries its flight log as a git note: the intent, the signals, every clearance and its reason, any go-around. git log explains why main looks the way it does, and the next agent reads it over MCP before it starts.

From a real run: 5 PRs, 10 pairs checked, 1 conflict found in 6 seconds, 1 rebase where rebasing on every landing needs 10. Rebases grow with real conflicts, not with the number of agents.

It works today on deployed Cloudflare resources: a scripted five-agent run, and real Claude Code agents with colliding tasks that both landed with no human help, main green at the end. An agent joins with one MCP command, and people watch everything on one screen: the runway.
<!-- vision:end -->

## How you used Cloudflare (2000)

<!-- cloudflare:start -->
Everything runs on Cloudflare: one Worker and its bindings.

Artifacts: all repo storage. One baseline repo per project and one fork per agent, created with the Workers binding (fork, createToken). Agents use plain git over HTTPS with repo-scoped tokens. The coordinator reads forks without cloning (log, readTree, readBlob) to diff each fork against its true merge base. Each landed commit gets its flight log as a git note under refs/notes/atc.

Artifacts event subscriptions + Queues: every fork has a "pushed" subscription that delivers to a queue. The Worker's queue consumer hands each push to the coordinator, so pushes drive everything. No polling, no webhooks to host.

Workers: one Worker serves the API, MCP endpoint, dashboard and queue consumer.

Durable Objects (SQLite): one Coordinator per repo holds the in-flight index (touched files, symbol deltas, imports), intents, signals, pair-check results, the landing sequence and an event log. It pushes every change to dashboards over hibernatable WebSockets and records snapshots for replay.

Workflows: one durable, retried pipeline per push: index the fork, update signals, then run speculative merges against every other fork.

Containers (Sandbox SDK model): a Checker Durable Object owns a container with node, git and tsc. It runs the speculative merge plus typecheck for each pair, and the landing merge onto current main. It caches results by git tree hash and keeps main's incremental TypeScript state, so a pair check is usually one tsc run.

Agents SDK (MCP): a stateless MCP server with start_work, declare_intent, get_signals, get_clearance, request_land and get_history. A Claude Code session joins with one "claude mcp add" command.

Why this fit: forks are cheap and programmatic in Artifacts, so a fork per agent costs nothing. Push events plus Workflows make every push a durable check. A Durable Object gives each repo one consistent place to decide the landing order, which is what keeps it fast and race-free.
<!-- cloudflare:end -->

## Demo video

`submission/atc-demo.mp4` (6:52). Script: `VIDEO_SCRIPT_V8.md`.

## Open source repository URL (2048)

https://github.com/scottfrasso/air-traffic-control (**make it public and push `main` before submitting**)

## Instructions to run your project (4000)

<!-- instructions:start -->
Fastest look (no setup): open the public replay of a recorded run: <PUBLIC_REPLAY_URL>. It replays the real event log through the runway dashboard at 1x to 8x.

Run the full demo against your own Cloudflare account:

Prerequisites
- A Cloudflare account on Workers Paid (Artifacts open beta, Containers, Workflows, Queues)
- Node 24 (local scripts only need Node 22+), pnpm 10, git, Docker (to build the checker container image)
- An API token with Artifacts Edit and Queues Edit

Setup
1. git clone https://github.com/scottfrasso/air-traffic-control && cd air-traffic-control && pnpm install
2. In worker/wrangler.jsonc set CF_ACCOUNT_ID, and after step 3 set PUSH_QUEUE_ID.
3. cd worker && pnpm exec wrangler queues create agentmesh-push-events
4. Create the Artifacts namespace "agentmesh" (one REST call, shown in README "Deploy your own").
5. pnpm exec wrangler secret put AGENTMESH_API_KEY (any random string; it protects /api, /mcp and the dashboard)
6. pnpm exec wrangler secret put CF_API_TOKEN (Queues Edit; used to create per-fork push subscriptions)
7. pnpm exec wrangler deploy
8. Back at the repo root, create .env with CLOUDFLARE_API_TOKEN=... and AGENTMESH_API_KEY=... (same value as step 5). Also set CLOUDFLARE_ACCOUNT_ID, and AGENTMESH_URL to your Worker URL.

Start it
./demo/run.sh

This runs the acceptance test end to end in about a minute against real Artifacts. Five scripted agents fork the repo. One changes a function's signature and another adds a new caller in a different file. Plain git reports no conflict, and ATC signals a semantic conflict to both before either asks to land. The first lands, only the second goes around and fixes its call, the three independent changes land with no rebase, and main typechecks. It prints a dashboard link; paste the API key once.

Real coding agents
pnpm --dir demo exec tsx src/live.ts 4
This creates a fresh repo and prints 4 agent prompts plus the "claude mcp add" command. Paste each prompt into its own Claude Code session. Details: handover/02-run-real-claude-code-agents.md

Tests: cd worker && pnpm test
Clean up: pnpm --dir demo exec tsx src/teardown.ts
<!-- instructions:end -->

## Checkboxes

- ☐ I confirm this project was built using Cloudflare Workers and Artifacts.
- ☐ I confirm this submission follows the competition terms.

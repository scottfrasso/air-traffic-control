# AGENTS.md

Guidance for any coding agent (Claude Code or otherwise) working in this repo.

## Mission

See `prompt.md`. Build a coordination layer for many coding agents on one repo,
on Cloudflare Workers + Artifacts. The competition entry was submitted on 2026-10-14; the repo is public.

## Competition (read before changing scope)

- Rules, judging weights, form fields, competitors: [`docs/research/competition.md`](docs/research/competition.md).
  What they force on us: [ADR-0017](docs/adr/0017-competition-requirements.md).
- Judging: 50% originality/quality, 25% concurrency/coordination/context/review/conflicts, 25% ease of use.
  Prefer work that moves one of those scores.
- Hard requirements: 5–10 min demo video, public repo with LICENSE, a person submits the form (no automated entry).
- Priority work is in GitHub issues labelled `competition` (`P0` > `P1` > `P2`). The current plan, in order, is in
  `handover/04-next.md` (local only; `handover/` is gitignored) and summarised under Next in `PROGRESS.md`.
- The repo is public: never commit secrets or personal details (email, location). `handover/` stays local.
  Never change repo visibility yourself.
- Put new research in `docs/research/` so it isn't looked up twice.

## Documentation sources — use these, never guess an API

- **Start here:** https://www.cloudflare.com/llms.txt — top-level Cloudflare index.
  Make extensive use of it whenever a Cloudflare product, feature, or limit is in question.
  Every page on cloudflare.com is available as markdown by appending `.md`.
- Developer docs index: https://developers.cloudflare.com/llms.txt — each product links
  to its own `llms.txt`.
- Per-product indexes used here:
  - Artifacts: https://developers.cloudflare.com/artifacts/llms.txt
  - Durable Objects: https://developers.cloudflare.com/durable-objects/llms.txt
  - Workflows: https://developers.cloudflare.com/workflows/llms.txt
  - Sandbox SDK: https://developers.cloudflare.com/sandbox/llms.txt
  - Agents SDK / MCP: https://developers.cloudflare.com/agents/llms.txt
  - Queues (event subscriptions): https://developers.cloudflare.com/queues/llms.txt
- Any docs page can be fetched as markdown: append `index.md` to the URL, or send
  `Accept: text/markdown`.
- Artifacts is in open beta (2026-10-01). Treat training-data knowledge of it as
  unreliable; verify in docs or with a spike, and record findings in `DECISIONS.md`.

## Working rules

- TypeScript, strict. Use **pnpm**, never npm.
- Never print or commit secrets. `CLOUDFLARE_API_TOKEN` lives in `.env` (gitignored).
- Only touch resources this project creates (all prefixed `agentmesh`).
- Keep `PROGRESS.md` (done / next / blocked) and `DECISIONS.md` current.
- Commit after each verified milestone.

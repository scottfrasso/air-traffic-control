# AGENTS.md

Guidance for any coding agent (Claude Code or otherwise) working in this repo.

## Mission

See `prompt.md`. Build a coordination layer for many coding agents on one repo,
on Cloudflare Workers + Artifacts. Deadline: 2026-10-14.

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

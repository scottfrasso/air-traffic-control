# AGENTS.md

Guidance for any coding agent (Claude Code or otherwise) working in this repo.

## Mission

Build the review side of a code host on Cloudflare: pull requests on Cloudflare Artifacts repos that start as drafts,
and, when marked ready, a pipeline that runs the repo's CI and then Claude Managed Agents (classifier, correctness,
security, tests, verifiers) and gates merge on the result. Design: [ADR-0027](docs/adr/0027-pr-review-pipeline.md).
The goal: the least human review time per change that doesn't raise reverts.

History: this repo started as Air Traffic Control, a hackathon entry submitted on 2026-10-14
([`docs/research/competition.md`](docs/research/competition.md)); that code is in git history before ADR-0027.

## Working agreements

- The repo is public: never commit secrets or personal details (email, location). `handover/` stays local.
  Never change repo visibility yourself.
- Design specs and implementation plans (`docs/superpowers/specs/`, `docs/superpowers/plans/`) stay local (git-ignored).
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
- Claude Managed Agents: https://platform.claude.com/docs/en/managed-agents/overview (beta header `managed-agents-2026-04-01`).
- Artifacts is in open beta (2026-10-01). Treat training-data knowledge of it as
  unreliable; verify in docs or with a spike, and record findings in `DECISIONS.md`.

## Working rules

- TypeScript, strict. Use **pnpm**, never npm.
- Never print or commit secrets. `CLOUDFLARE_API_TOKEN` lives in `.env` (gitignored).
- Only touch resources this project creates (all prefixed `agentmesh`).
- Keep `PROGRESS.md` (done / next / blocked) and `DECISIONS.md` current.
- Commit after each verified milestone.

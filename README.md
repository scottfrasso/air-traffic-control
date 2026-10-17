# Reviews on Cloudflare

Pull requests on Cloudflare Artifacts repos, reviewed by Claude agents before a person has to look.

A pull request starts as a **draft**: push as often as you like, nothing runs. Mark it **ready** and a review run
starts for that exact commit:

1. **CI** runs the repo's own commands (`.atc/ci.yml`) in a container. If anything fails, the run stops there: no
   agent time is spent on a red PR.
2. A **classifier** agent reads the change and the author's intent and decides the risk tier (low, medium, high),
   whether a person must look and why, and which reviewers to run.
3. **Reviewers** run in parallel: correctness, security, tests. Each reports findings with evidence.
4. **Verifiers** check every important finding independently; only findings that two of three votes confirm are
   posted. Nits (at most five per reviewer) are shown but never block.
5. The **verdict** is computed in code: CI, review (clean, findings, incomplete), security (clear, blocking), the
   risk tier and how many human approvals it needs (0, 1 or 2), and what still blocks the merge.

A push to a ready PR starts a new review of the new head; follow-up reviews look only at what changed since and
don't repeat findings the author already answered. Approvals cover one commit. An agent's approval never counts as a
person's. Merging re-runs CI on the merged commit and only then moves the target branch.

Design and every decision: [ADR-0027](docs/adr/0027-pr-review-pipeline.md).

## How it's built

| Piece | Cloudflare | What it does |
|---|---|---|
| Repos | Artifacts | Git hosting; people and agents push branches with plain git |
| PR store | Durable Object per repo (SQLite) | PRs, review runs, checks, findings, approvals, events |
| Push events | Queues (per-repo event subscription) + DLQ | A push to any branch moves the PRs on it |
| Review run | Workflows | One durable run per PR head: snapshot → CI → classifier → reviewers → verifiers |
| Container | Containers (Durable Object–managed) | Snapshots, CI commands, merges, diffs |
| Agents | Claude Managed Agents | Classifier, correctness, security, tests, verifier; each session has a budget |
| People | Cloudflare Access + personal API tokens | Who approves; agents act as the person whose token they use |

No repo credential ever enters an agent's sandbox: the container builds a read-only snapshot and the agents get
files. Repo and PR content is treated as data, never as instructions.

## Set it up

You need a Cloudflare account (Workers Paid, Artifacts, Containers, Queues), Docker for the container image, and an
Anthropic API key with Managed Agents access.

1. Put `CLOUDFLARE_API_TOKEN` and `ANTHROPIC_API_KEY` in `.env` at the repo root (git-ignored).
2. `pnpm install`
3. `pnpm setup:agents` creates the five review agents and their sandbox environment, and writes their ids into
   `worker/wrangler.jsonc`. `--dry-run` shows the plan.
4. `pnpm setup:cloudflare` creates the queues and the Artifacts namespace and deploys the Worker with its secrets.
5. Put **Cloudflare Access** in front of the Worker, and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in
   `worker/wrangler.jsonc`.
6. Sign in, create a repository and a personal API token in the UI.

Per repo, add:

```yaml
# .atc/ci.yml: the CI that gates the agents
commands:
  - name: install
    run: pnpm install --frozen-lockfile
  - name: test
    run: pnpm test
    timeout: 600
```

Optional: `.atc/review.yml` (session budgets in US cents: `classifier`, `reviewer`, `verifier`), `.atc/owners`
(globs of paths that always need a person), and `REVIEW.md` (what failure looks like in this repo; every reviewer
reads it).

## For coding agents

MCP at `/mcp` with a personal token (`Authorization: Bearer atc_…`): `open_pr`, `mark_ready`, `get_pr` (verdict,
checks, open findings) and `resolve_finding`. The same operations are in the JSON API under `/api/repos/:repo/prs`.

## Develop

```bash
pnpm -r typecheck
pnpm test            # Worker: policy, store, orchestration (fake agents), container modes (local git), API, UI contract
pnpm e2e:review      # live: a repo with two planted bugs must be caught, blocked, fixed and merged (needs a deployment)
```

## Status

Built and tested with fakes; not yet run against real Managed Agents. See [PROGRESS.md](PROGRESS.md).

## History

This repo began as **Air Traffic Control**, a coordination layer for many coding agents on one repo, entered in a
Cloudflare hackathon on 2026-10-14 ([video](submission/atc-demo.mp4), [60 s cut](submission/atc-linkedin.mp4)).
That code is in the git history before ADR-0027.

MIT licensed.

# ADR-0025: One-command deploy (`pnpm setup:cloudflare`)

- Status: Accepted.
- Date: 2026-10-14. Issue #18.

## Context
Ease of use is 25% of the judging. Deploying took about eight manual steps: create the queue, create the Artifacts
namespace over REST, edit two IDs in `wrangler.jsonc`, put two secrets, deploy, then write `.env` for the demo.

## Decision
`demo/src/setup.ts`, run as `pnpm setup:cloudflare [--dry-run]`, reads the repo-root `.env` and, idempotently:
- finds the account (`CLOUDFLARE_ACCOUNT_ID`, or the token's only account);
- creates `agentmesh-push-events` and `agentmesh-push-events-dlq` (Queues REST) and the `agentmesh` Artifacts namespace,
  only if missing;
- writes `CF_ACCOUNT_ID` and `PUSH_QUEUE_ID` into `worker/wrangler.jsonc` (only those two values change);
- generates `AGENTMESH_API_KEY` into `.env` if missing (never printed);
- deploys with `wrangler deploy --secrets-file` (a 0600 temp file, deleted after), setting `AGENTMESH_API_KEY` and
  `CF_API_TOKEN` (the narrower `CLOUDFLARE_AGENTMESH_WORKER_API_KEY` if present, else the main token, with a note);
- writes `AGENTMESH_URL` (from the deploy output) and `CLOUDFLARE_ACCOUNT_ID` into `.env`, so `./demo/run.sh` targets
  that deployment.
It prefers IPv4 (`setDefaultResultOrder("ipv4first")`), since IP-filtered API tokens commonly allow IPv4 only;
error 9109 is reported as "allow this IP on the token".

## Consequences
- A fresh account goes from clone to `./demo/run.sh` in three commands.
- Tested on this account only (everything already existed, so only the IDs check and the deploy ran). A second account
  wasn't available, so first-time creation of the queues and namespace is untested end to end.

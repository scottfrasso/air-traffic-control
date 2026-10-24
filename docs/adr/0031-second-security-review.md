# ADR-0031: Second security review: a merge gate that holds, and dependency updates

- Status: Accepted.
- Date: 2026-10-23.
- Amends ADR-0030.

## Context
A second full security review (with a dependency audit) found that ADR-0030's protected main could still be bypassed:
a merge used whatever main was at that moment as its base, so a direct push the guard hadn't undone yet became a
merge's parent, and therefore permanent. A force push to an unrelated history could also make the restore fail for
good once the container's cache was cold. `pnpm audit` reported 11 advisories (6 high), all in the MCP SDK.

## Decision
- **Merges build only on the protected commit.** A merge onto main first checks that main is at `protected:main`; if
  not, it refuses and puts main back. If main moves while a merge runs (the container answers "target moved"), the
  merge stops and main is put back, instead of retrying onto the new head.
- **Restores work from a cold cache.** Every merge onto main also force-pushes its commit to a hidden ref,
  `refs/atc/protected/main`; a restore reads the branch with `ls-remote`, fetches the branch and, if the protected
  commit still isn't there, the hidden ref, then pushes back with force-with-lease. A deleted main is re-created.
- **A failed restore freezes merges.** `frozen:main` blocks every merge with a message for a person, until main is
  back on the protected commit (the guard clears it).
- **The guard ignores abandoned locks.** The merge lock stores its start and time limit; a lock past its limit (a
  crash, a deploy mid-merge) no longer switches the guard off. A merge calls the guard itself when it has to.
- **Findings.** With no last reviewed commit (say the first run was cancelled), nothing earlier becomes fixed. A
  finding labelled "pre-existing" on a line the PR adds is important (and verified). Earlier open findings go to
  reviewers as `open-findings.json`, never inside the instructions. Changed paths come from `git diff -z` (real names:
  quoted non-ASCII paths no longer escape `.atc/owners` globs).
- **Cost.** A person may start 200 runs a day across all repos (`REVIEW_MAX_RUNS_PER_PERSON_PER_DAY`, counted only
  when a run actually starts). Containers are one per repo (a Durable Object each; wrangler doesn't allow
  `max_instances` for those), so the 50-repos-per-person cap bounds how many one person can run at once.
- **Identity.** A bearer that isn't a valid personal token is refused (never retried as the Access cookie); a JWT must
  carry the team's issuer and be past its `nbf`; a token can revoke itself (others still need Access); tokens from
  before expiry existed now expire 90 days after creation.
- **Responses.** The UI's inline script is allowed by its SHA-256 hash instead of `'unsafe-inline'`; every response
  says `nosniff`; unexpected errors return "internal error" and are logged, not echoed.
- **CI.** A job's uid comes from its process id (two concurrent jobs never share one, so the kill after a job can't hit
  another); each job has its own `TMPDIR`; git output up to 64 MB (a diff over 1 MB used to fail). The diff cache keeps
  20 entries.
- **Dependencies.** `@modelcontextprotocol/server` 2.3.1 (our `/mcp`), `agents` 0.30.0 with its MCP peers pinned to
  patched releases (`@modelcontextprotocol/sdk` 1.32.1, `@modelcontextprotocol/client` 2.3.1; `agents` itself still asks
  for vulnerable ones), `ip-address` 10.7.4 by override, wrangler 4.152.0, zod 4.6.7, pnpm 10.34.7. The container base
  image is re-pinned to the 10-23 digest and takes Debian security updates at build. `pnpm audit`: none.

## Consequences
- An agent with a token can still push to main, but it can't stay there and can't become a merge's base; if it can't
  be undone, nothing merges until a person fixes main.
- Known limits, not fixed here:
  - The first protected commit is main's head when the store first sees it (first PR, first event, or first alarm),
    so in a brand-new repo someone with a token could get there first. Every token can write every repo (per-repo
    permissions are a later slice), and a push into someone else's PR branch keeps that PR's author.
  - The admin bootstrap can mint a token for any email; remove it once Access is set up.
  - CI containers have open internet egress; `workers_dev` is on (set it off behind a custom domain with Access).
  - `safe.directory` is `*` in the image.
  - Heads are read by bare branch name: Artifacts' `log` doesn't resolve `refs/heads/<branch>` (tried live; every
    branch came back missing), so whether a tag named `main` could shadow the branch is unconfirmed. The restore
    itself uses `refs/heads/main` (ls-remote, force-with-lease), so it never acts on a tag.

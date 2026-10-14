# 17. The competition rules shape the submission

Date: 2026-10-11

## Status

Accepted

## Context

We built to `prompt.md`. On 2026-10-11 we read the official rules
(https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) and the submission form.
Details and sources are in [`docs/research/competition.md`](../research/competition.md). Some rules conflict with
what we had:

- The demo video must be **5–10 minutes** (rules §4). Our v7 cut was 2:57 (ADR-0016 aimed for "about a minute" to 3).
- The source must be in a **public** repository under MIT, Apache-2.0 or BSD with a LICENSE file. Ours was private.
- Judging (§6), scored 1–5 each:
  - 50% originality and quality;
  - 25% concurrency, coordination, **context preservation**, **review** and conflict handling;
  - 25% ease of use and UX.
- Automated entry is prohibited. A person submits the form.
- No attacks on any product, competitors included.

## Decision

- **Video v8** runs about 6–7 minutes in three parts: say what we'll show, show it, recap it. It explains the
  problem with plain graphics before the airport metaphor appears. Script: `submission/VIDEO_SCRIPT_V8.md`. It keeps
  ADR-0016's pipeline (Remotion, ElevenLabs, one recorded run).
- Narration describes today's tools ("conflicts show up at merge time") instead of criticising GitHub by name.
- **Competition work is tracked as GitHub issues** labelled `competition` with a `P0`/`P1`/`P2` label. P0 means the entry
  is invalid or much weaker without it.
- The form answers live in `submission/FORM_DRAFT.md`, and `submission/check-form.sh` checks them against the form's limits.

## Consequences

ADR-0016's length target is superseded. Context preservation and review are now explicit product gaps (issues),
not out of scope. Before each change, ask whether it moves one of the three scores.

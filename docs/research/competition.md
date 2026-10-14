# Competition research

_Collected 2026-10-11. Sources at the bottom. Re-check the official rules PDF if anything here is in doubt; it wins over this file._

Related: [ADR-0017](../adr/0017-competition-requirements.md) (what the rules force on us), the GitHub issues labelled `competition`.

## The competition

- **Name:** "Build the Next-Gen Git Platform on Cloudflare" (the site calls it "Build the next GitHub").
  Page: https://www.cloudflare.com/git-competition/ · Form: https://www.cloudflare.com/git-competition/submit
- **Deadline:** **2026-10-14, 11:59 PM PDT.** Three finalists announced **2026-10-16**.
- **Finals:** each finalist gets **10 minutes live on stage** at Cloudflare Connect, Moscone West, SF, on **2026-10-21**.
  Cloudflare covers travel for up to 2 people per team. The winner must be there in person.
- **Prize:** 1st place gets $25K in Cloudflare credits (valid 12 months) and the VIP speaker dinner.
- **Eligibility:** legal resident (where you live, not citizenship) of the US, Canada, UK, Australia, South Africa or Finland, 18 or older at the start (terms §3). One submission per entrant.
  **Automated entry is prohibited**, so a human fills in and submits the form. (The browser recon below was read-only.)

## Hard requirements (from the official rules PDF)

| Requirement | Our status |
| --- | --- |
| **5–10 minute demo video** | ❌ **Ours is 2:57. Too short, which could void the entry.** Needs a new cut of about 6–8 min. |
| Open-source repo, MIT / Apache-2.0 / BSD, with a LICENSE file | ⚠️ LICENSE (MIT) exists, but **the repo `scottfrasso/air-traffic-control` is PRIVATE** and `main` is 9 commits ahead of origin. Make it public and push. |
| Instructions to run it | ✅ README has them. Needs a short version for the form (4000 chars max). |
| Built on Workers **and** Artifacts | ✅ |
| Must "enable multiple agents working on changes concurrently" | ✅ 5 scripted PRs and 2 real Claude Code agents |
| No personal attacks on any product, including competitors | ⚠️ Avoid "GitHub is bad" framing. Say "today's tools find conflicts at merge time." |
| Original work, no third-party copyrighted art | ⚠️ We use the Cloudflare logo in the video. Fine for a Cloudflare contest, but use only their official asset. |

## Judging (rules §6). Each criterion is scored 1–5.

| Weight | Criterion | What it means for us |
| --- | --- | --- |
| **50%** | Originality and quality of the prototype for agent-oriented software collaboration | Also breaks ties. The **landing sequence (ATC)** and **compiler-checked semantic conflicts found before landing** are our original pieces. Pairwise trial merges alone are a common idea (see competitors). |
| **25%** | Multi-agent concurrency, coordination, **context preservation**, **review**, conflict handling | Concurrency, coordination and conflicts are strong. **Context preservation and review are weak or unaddressed.** |
| **25%** | Ease of use and product/user experience | The dashboard is a plus. Judges can't run anything without our API key or a Cloudflare account, so add a public read-only replay link. |

What the blog asks for (Kozlov & Piasecki, 2026-10-01): "not GitHub with agents bolted on." Questions it raises:
- How do agents know what others are doing?
- How are conflicting changes handled?
- How does output get reviewed?
- How do we track **why** a change was made?
- How do you compare and choose among multiple changes ("which one should ship")?

Suggested products: Workers, Artifacts, Workers Builds, Workers Previews, bindings, event subscriptions, Workflows.
The video should cover **what was built, what it enables, and how it works**.

## The submission form (read-only recon via Browser Use, 2026-10-11)

All fields are required unless marked optional. There are no visible character counters; the limits below are HTML `maxlength`.

| Section | Field | Type | Limit / placeholder |
| --- | --- | --- | --- |
| Team | Team name | text | 120 |
| Team | Primary contact name / email | text / email | 120 / 254 |
| Team | Team location | free text | 160 |
| Team | First attendee name / email | text / email | 120 / 254 |
| Team | Second attendee name / email | optional | 120 / 254 |
| Project | Project name | text | 160 |
| Project | **Project vision** | textarea | **2000**. "What did you rethink, and why does it matter?" |
| Project | **How you used Cloudflare** | textarea | **2000**. "Describe the Cloudflare products and architecture in your project." |
| Demo | Demo video | file | MP4/WebM/MOV, ≤ 2 GiB |
| Demo | Open source repository URL | url | "https://github.com/your-team/project" |
| Demo | **Instructions to run your project** | textarea | **4000**. "Include prerequisites, setup steps, and the command that starts the project." |
| — | ☐ Built using Cloudflare Workers and Artifacts · ☐ Follows the competition terms | checkboxes | both required |

There is a review step before the upload starts, and the page has a Turnstile check. Drafted answers are in [`submission/FORM_DRAFT.md`](../../submission/FORM_DRAFT.md).

## What others are building (GitHub, as of 2026-10-11; every repo had 0 stars)

Closest to us:
- **Tartan** (github.com/rawkode/tartan): agents claim work with a footprint and get overlap notices through MCP. Trunk only moves through "the Advance", a queue that lands exactly what was tested and writes a why-note. Live demo, one-command deploy. **Probably the most polished direct competitor.**
- **Agent Branches** (github.com/alexeygrigorev/cloudflare-agent-git): a fork per agent and a DO coordinator that test-merges every pair. Not deployed, scripted agents. Its own research says real clashes are "real but rare."
- **gittub** (github.com/hemanth/gittub): AST symbol locks as intents, "why" notes in `refs/notes/agents`, merge arenas.
- **Locus** (github.com/arjunkshah12345-hash/locus): path/symbol lease board over MCP; overlapping work goes to an "arena" a referee scores.
- **Keel** (github.com/bimsonz/keel): "Agents don't collide on lines. They collide on beliefs." Generates a test that proves two changes are incompatible.
- **SemaLane** (github.com/lexaelauryn-spec/semalane): work contracts, semantic conflict detection, a review quorum.

Different angles: Canon (behavioural facts checked on Workers Previews), Cinq (blind examiner writes hidden tests),
Fork Arena (forks compete on live traffic), Shipboard (trial merges with isomorphic-git in a DO), Merge Arena, Confluence, Switchyard.

**Takeaway:** a fork per agent, intent claims and pairwise trial merges are now **table stakes**. Ours is the only one
we found that does all of the following, live on Artifacts:
- a compiler-checked semantic conflict found **before** anyone asks to land;
- a **landing sequence with one clearance and one reason per PR**;
- **only the truly conflicting PR rebases**;
- real Claude Code agents.

The video and form must say this plainly.

## Community commentary

- **HN thread:** skeptical. People called it marketing for Artifacts, said a credit prize is small and raised lock-in.
  Some asked "why hundreds of agents on one repo?" One called reviewing thousands of agent commits "a torture device."
- **What people say is missing:** recording *why* an agent made a change (provenance, git notes, linking sessions to
  commits), review at agent scale, and cheap parallel views.
- **lord.technology:** "conflicting assumptions can merge cleanly". That is our pitch exactly; quote the idea, not the person.
- **devopsdaily (dev.to):** failed pushes on a shared branch grow about N(N-1)/2, roughly 700 at 40 agents. That gives us a ready-made
  way to state the problem with numbers.

## Recommended changes, by impact on score

1. **Re-cut the video to 6–8 min** (required). Use the "tell them what you'll tell them, tell them, tell them what you told them"
   structure. Add problem graphics before the airport. Script: [`submission/VIDEO_SCRIPT_V8.md`](../../submission/VIDEO_SCRIPT_V8.md).
2. **Make the repo public and push `main`** (required). Run the TruffleHog scan on the full history again first.
3. **Context preservation (25% bucket, cheap win):** when ATC lands a PR, write a git note or trailer on the landed commit with
   the agent's declared intent, the signals it received, its clearance history and why it went around. Show it in the video as
   "the why travels with the commit."
4. **Review story:** frame the runway as the review surface, one screen for what's in flight, what conflicts and what
   lands next. If there's time, add a "review" hold state (an agent reviewer or a human approves before CLEARED).
5. **Ease of use:** publish a public read-only replay URL (`/r/<baseline>?replay`, no key) and put it first in the form's run
   instructions so judges can see it in 10 seconds.
6. **Numbers:** show what's avoided at scale (e.g. N agents → pairs checked, rebases avoided vs. rebase-everyone) so the
   "clashes are rare" objection doesn't land.

## Sources

- Competition page: https://www.cloudflare.com/git-competition/
- Submission form: https://www.cloudflare.com/git-competition/submit
- Official rules: https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf
- Announcement: https://blog.cloudflare.com/next-git-platform-on-cloudflare/
- HN: https://news.ycombinator.com/item?id=49947051
- https://lord.technology/2026/10/03/what-the-next-git-platform-needs-to-remember.html
- https://dev.to/devopsdaily/a-repo-per-agent-what-cloudflare-artifacts-changes-about-git-3m5b
- https://dev.to/mech_app_ai/cloudflare-artifacts-what-building-a-git-platform-for-ai-agents-reveals-about-event-driven-pm7
- https://ostechnix.com/cloudflare-build-git-ai-agents/ · https://gihyo.jp/article/2026/10/cloudflare-artifacts-open-beta

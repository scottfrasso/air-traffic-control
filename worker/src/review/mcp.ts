import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Directory } from "./directory";
import type { Person } from "./identity";
import type { RepoStore } from "./store";
import { CHECK_NAMES, type CheckName } from "./types";

export interface McpEnv {
  REPOS: DurableObjectNamespace<RepoStore>;
  DIRECTORY: DurableObjectNamespace<Directory>;
}

/**
 * What a coding agent can do, as the person its token belongs to: open a draft PR, mark it ready, read its verdict
 * and findings, and answer a finding. Plain functions (tested directly); the MCP server below only registers them.
 */
export function reviewTools(env: McpEnv, person: Person) {
  // Like the HTTP API: only registered repos (a typo would otherwise create an empty store).
  const repo = async (name: string) => {
    if (!(await env.DIRECTORY.getByName("directory").hasRepo(name))) throw new Error(`no repo ${name}`);
    return env.REPOS.getByName(name);
  };
  return {
    open_pr: async (a: { repo: string; title: string; source: string; target?: string; intent?: Record<string, string> }) =>
      (await repo(a.repo)).openPr({ title: a.title, author: person.email, source: a.source, ...(a.target ? { target: a.target } : {}), ...(a.intent ? { intent: a.intent } : {}) }),
    run_checks: async (a: { repo: string; pr: number; sha?: string; only?: CheckName[] }) =>
      (await repo(a.repo)).runChecks(a.pr, person.email, { ...(a.sha ? { sha: a.sha } : {}), ...(a.only ? { only: a.only } : {}) }),
    mark_ready: async (a: { repo: string; pr: number }) => (await repo(a.repo)).markReady(a.pr, person.email),
    get_pr: async (a: { repo: string; pr: number }) => {
      const v = await (await repo(a.repo)).getPr(a.pr);
      return {
        id: v.pr.id, title: v.pr.title, state: v.pr.state, head: v.pr.head, verdict: v.verdict, // verdict.checks: not_run | running | done | partial | stale
        checks: v.checks.map((c) => ({ name: c.name, kind: c.kind, status: c.status, log: c.status === "passed" ? undefined : c.log.slice(-2000) })),
        openFindings: v.findings.filter((f) => f.status === "open").map((f) => ({ id: f.id, reviewer: f.reviewer, severity: f.severity, file: f.file, line: f.line, class: f.class, title: f.title, evidence: f.evidence, suggestion: f.suggestion })),
      };
    },
    resolve_finding: async (a: { repo: string; pr: number; finding: number; kind: "wrong" | "intentional" | "wontfix"; reason: string }) =>
      (await repo(a.repo)).resolveFinding(a.pr, a.finding, person.email, a.kind, a.reason, "token"), // MCP is always an agent's token
  };
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function server(env: McpEnv, person: Person) {
  const t = reviewTools(env, person);
  const s = new McpServer({ name: "atc-review", version: "0.2.0" });
  const repo = z.string().describe("Repository name");
  const pr = z.number().int().positive().describe("PR number");
  s.registerTool("open_pr", {
    description: "Open a draft pull request for a pushed branch. Pushes never run anything: push as often as you like, then call run_checks when the work is done. Fill in the intent (what, why, testing, risk, revert): the reviewers read it.",
    inputSchema: z.object({ repo, title: z.string().min(1), source: z.string().describe("Branch with your work"), target: z.string().optional().describe("Branch to merge into (default main)"), intent: z.object({ what: z.string(), why: z.string(), testing: z.string(), risk: z.string(), revert: z.string() }).partial().optional() }),
  }, async (a) => text(await t.open_pr(a)));
  s.registerTool("run_checks", {
    description: "Your work is done: run the checks on the PR's head (CI, then risk triage, then the review agents, then verification). They cost money, so call this once you're done, not after every push; pushes never run anything. Pass sha (7+ characters is enough) to make sure it's the commit you mean, even if you pushed a moment ago. Pass only (e.g. [\"ci\"] or [\"security\"]) to run single checks while you iterate; merging still needs a full run on the head. Then poll get_pr until verdict.checks isn't running, and read verdict.blockers: done, partial (single checks) or stale (you pushed since) each tell you what's next.",
    inputSchema: z.object({ repo, pr, sha: z.string().optional().describe("The commit you're done with (must be the head)"), only: z.array(z.enum(CHECK_NAMES as [CheckName, ...CheckName[]])).optional().describe("Run only these checks") }),
  }, async (a) => text(await t.run_checks(a)));
  s.registerTool("mark_ready", {
    description: "Older name for run_checks with no options: runs all the checks on the head.",
    inputSchema: z.object({ repo, pr }),
  }, async (a) => text(await t.mark_ready(a)));
  s.registerTool("get_pr", {
    description: "A PR's verdict (CI, review, security, risk tier, approvals needed, blockers), its checks with logs of failures, and its open findings. Fix findings with a push, or answer them with resolve_finding.",
    inputSchema: z.object({ repo, pr }),
  }, async (a) => text(await t.get_pr(a)));
  s.registerTool("resolve_finding", {
    description: "Answer a nit or pre-existing finding you won't fix: wrong, intentional, or wontfix, with a reason. Important findings can't be resolved here: fix them with a push, or ask a person to resolve them in the web UI.",
    inputSchema: z.object({ repo, pr, finding: z.number().int().positive(), kind: z.enum(["wrong", "intentional", "wontfix"]), reason: z.string().min(1) }),
  }, async (a) => text(await t.resolve_finding(a)));
  return s;
}

export function handleReviewMcp(request: Request, env: McpEnv, ctx: ExecutionContext, person: Person): Promise<Response> {
  return createMcpHandler(() => server(env, person), { route: "/mcp" })(request, env as never, ctx);
}

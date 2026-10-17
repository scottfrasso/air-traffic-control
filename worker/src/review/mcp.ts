import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Directory } from "./directory";
import type { Person } from "./identity";
import type { RepoStore } from "./store";

export interface McpEnv {
  REPOS: DurableObjectNamespace<RepoStore>;
  DIRECTORY: DurableObjectNamespace<Directory>;
}

/**
 * What a coding agent can do, as the person its token belongs to: open a draft PR, mark it ready, read its verdict
 * and findings, and answer a finding. Plain functions (tested directly); the MCP server below only registers them.
 */
export function reviewTools(env: McpEnv, person: Person) {
  const repo = (name: string) => env.REPOS.getByName(name);
  return {
    open_pr: async (a: { repo: string; title: string; source: string; target?: string; intent?: Record<string, string> }) =>
      repo(a.repo).openPr({ title: a.title, author: person.email, source: a.source, ...(a.target ? { target: a.target } : {}), ...(a.intent ? { intent: a.intent } : {}) }),
    mark_ready: async (a: { repo: string; pr: number }) => repo(a.repo).markReady(a.pr, person.email),
    get_pr: async (a: { repo: string; pr: number }) => {
      const v = await repo(a.repo).getPr(a.pr);
      return {
        id: v.pr.id, title: v.pr.title, state: v.pr.state, head: v.pr.head, verdict: v.verdict,
        checks: v.checks.map((c) => ({ name: c.name, kind: c.kind, status: c.status, log: c.status === "passed" ? undefined : c.log.slice(-2000) })),
        openFindings: v.findings.filter((f) => f.status === "open").map((f) => ({ id: f.id, reviewer: f.reviewer, severity: f.severity, file: f.file, line: f.line, class: f.class, title: f.title, evidence: f.evidence, suggestion: f.suggestion })),
      };
    },
    resolve_finding: async (a: { repo: string; pr: number; finding: number; kind: "wrong" | "intentional" | "wontfix"; reason: string }) =>
      repo(a.repo).resolveFinding(a.pr, a.finding, person.email, a.kind, a.reason, "token"), // MCP is always an agent's token
  };
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function server(env: McpEnv, person: Person) {
  const t = reviewTools(env, person);
  const s = new McpServer({ name: "atc-review", version: "0.2.0" });
  const repo = z.string().describe("Repository name");
  const pr = z.number().int().positive().describe("PR number");
  s.registerTool("open_pr", {
    description: "Open a draft pull request for a pushed branch. Nothing runs while it's a draft: push as often as you like, then call mark_ready. Fill in the intent (what, why, testing, risk, revert): the reviewers read it.",
    inputSchema: z.object({ repo, title: z.string().min(1), source: z.string().describe("Branch with your work"), target: z.string().optional().describe("Branch to merge into (default main)"), intent: z.object({ what: z.string(), why: z.string(), testing: z.string(), risk: z.string(), revert: z.string() }).partial().optional() }),
  }, async (a) => text(await t.open_pr(a)));
  s.registerTool("mark_ready", {
    description: "Mark a PR ready: CI runs, then (if green) the review agents. Every later push starts a new review of the new head. Poll get_pr until the verdict's review isn't pending.",
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

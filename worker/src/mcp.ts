import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { baselineOf } from "./artifacts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

const coordinatorFor = async (env: Env, baseline: string) => {
  const stub = env.COORDINATOR.getByName(baseline);
  await stub.ensure(baseline);
  return stub;
};

/**
 * The agent interface. Stateless (ADR-0009): a fresh McpServer per request, all state in the Coordinator DO.
 * Fork names are `<baseline>--<agent>`, so tools that take a fork can find the right Coordinator.
 */
function createServer(env: Env) {
  const server = new McpServer({ name: "agentmesh", version: "0.1.0" });

  server.registerTool(
    "start_work",
    {
      description:
        "Fork the baseline repo for this agent. Returns a git remote and a write token for your fork, plus a read token for the baseline. " +
        "Use `git -c http.extraHeader=\"Authorization: Bearer <token>\" clone <remote>`; push to your fork's main branch.",
      inputSchema: z.object({
        repo: z.string().describe("Baseline repo name"),
        agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/).describe("Short unique agent id, e.g. 'alice'"),
      }),
    },
    async ({ repo, agent }) => text(await (await coordinatorFor(env, repo)).createFork(agent)),
  );

  server.registerTool(
    "declare_intent",
    {
      description:
        "Tell other agents what you plan to touch before you start. Returns any in-flight work (other forks' changes and intents) that overlaps. " +
        "Overlaps are context, not commands: decide yourself whether to proceed, coordinate, or wait.",
      inputSchema: z.object({
        fork: z.string().describe("Your fork name, from start_work"),
        description: z.string().describe("One line: what you are about to do"),
        files: z.array(z.string()).default([]).describe("Repo-relative paths you expect to modify"),
        symbols: z.array(z.string()).default([]).describe("Exported symbols you expect to change or depend on"),
      }),
    },
    async ({ fork, description, files, symbols }) => text(await (await coordinatorFor(env, baselineOf(fork))).declareIntent(fork, description, files, symbols)),
  );

  server.registerTool(
    "get_signals",
    {
      description:
        "Informational notes about other agents' in-flight work that affects yours: signature changes to symbols you use, files you both edit, " +
        "semantic conflicts found by speculative merge+typecheck, and 'rebase required' after someone lands. Poll this after each push.",
      inputSchema: z.object({
        fork: z.string().describe("Your fork name"),
        include_resolved: z.boolean().default(false),
      }),
    },
    async ({ fork, include_resolved }) => {
      const signals = await (await coordinatorFor(env, baselineOf(fork))).getSignals(fork, include_resolved);
      return text(signals.length ? signals.map(({ id, kind, about_fork, symbol, message, resolved_at }) => ({ id, kind, about_fork, symbol, message, resolved: resolved_at !== null })) : "No open signals.");
    },
  );

  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => createServer(env), { route: "/mcp" })(request, env, ctx);
}

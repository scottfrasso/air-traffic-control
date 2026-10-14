import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { baselineOf } from "./artifacts";
import { startFork } from "./forks";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

const coordinatorFor = async (env: Env, baseline: string) => {
  const stub = env.COORDINATOR.getByName(baseline);
  await stub.ensure(baseline);
  return stub;
};

/**
 * The agent interface. Stateless (ADR-0009): a fresh McpServer per request, all state in the Coordinator DO.
 * Fork names are `<baseline>--pr<N>`, so tools that take a fork can find the right Coordinator.
 */
function createServer(env: Env) {
  const server = new McpServer({ name: "agentmesh", version: "0.1.0" });

  server.registerTool(
    "start_work",
    {
      description:
        "Open a pull request: ATC forks the baseline for you and assigns a PR number. Returns a git remote and a write token for your fork, plus a read token for the baseline. " +
        "Use `git -c http.extraHeader=\"Authorization: Bearer <token>\" clone <remote>`; push to your fork's main branch.",
      inputSchema: z.object({
        repo: z.string().describe("Baseline repo name"),
        agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/).describe("Short agent id, e.g. 'claude-1' (who is flying this PR)"),
      }),
    },
    async ({ repo, agent }) => text(await startFork(env, repo, agent)),
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
        "semantic conflicts found by speculative merge+typecheck, and 'go around' when a PR you conflict with lands first " +
        "(rebase onto the new main, fix, push, then land). Poll this after each push.",
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

  server.registerTool(
    "get_clearance",
    {
      description:
        "Ask Air Traffic Control (ATC) where your PR is in the landing sequence and why: cleared to land, follow another PR, hold for a conflicting PR (fix the conflict while you hold and you won't need to go around), " +
        "go around (rebase onto the new main, fix, push, then land), or standby while checks run.",
      inputSchema: z.object({ fork: z.string().describe("Your fork name, from start_work") }),
    },
    async ({ fork }) => text(await (await coordinatorFor(env, baselineOf(fork))).getClearance(fork)),
  );

  server.registerTool(
    "get_history",
    {
      description:
        "Why main looks the way it does: the flight log of every PR that landed, oldest first (intent, signals it got, ATC's clearances and reasons, " +
        "go-arounds). The same text is a git note on each landed commit: `git fetch <baseline> refs/notes/atc:refs/notes/atc && git log --notes=atc`. " +
        "Pass your fork to also get your own PR's log so far.",
      inputSchema: z.object({
        repo: z.string().describe("Baseline repo name"),
        fork: z.string().optional().describe("Your fork name, to include your in-flight PR's log"),
      }),
    },
    async ({ repo, fork }) => text(await (await coordinatorFor(env, fork ? baselineOf(fork) : repo)).getHistory(fork)),
  );

  server.registerTool(
    "request_land",
    {
      description:
        "Ask to merge your fork into the baseline. Lands only if your fork is current with baseline and green (typechecks). " +
        "If another fork conflicts with yours and is closer to landing (or ties with a smaller diff), you are told to wait; " +
        "if a PR you conflict with lands first, you go around: rebase onto the new main, fix, push, then land. If the response says retry, checks are still running.",
      inputSchema: z.object({ fork: z.string().describe("Your fork name") }),
    },
    async ({ fork }) => text(await (await coordinatorFor(env, baselineOf(fork))).requestLand(fork)),
  );

  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => createServer(env), { route: "/mcp" })(request, env, ctx);
}

/**
 * Live mode: prepare a fresh runway for REAL coding agents (e.g. several Claude Code sessions).
 * Seeds a baseline, then writes one ready-to-paste prompt per agent and prints the MCP setup + dashboard link.
 *
 *   pnpm --dir demo exec tsx src/live.ts [agents=4]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "./lib/env.ts";
import { seed } from "./seed.ts";

const count = Number(process.argv[2] ?? 4);
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
const baseline = await seed(`live-${stamp}`);
const protocol = readFileSync(join(ROOT, "agents/PROTOCOL.md"), "utf8");
const tasks = (JSON.parse(readFileSync(join(ROOT, "agents/tasks.json"), "utf8")) as Array<{ agent: string; task: string }>).slice(0, count);
const outDir = join(ROOT, ".dev/live", baseline);
mkdirSync(outDir, { recursive: true });
for (const [i, t] of tasks.entries()) {
  const prompt = protocol.replaceAll("{{BASELINE}}", baseline).replaceAll("{{AGENT}}", t.agent).replaceAll("{{TASK}}", t.task);
  writeFileSync(join(outDir, `agent-${i + 1}-${t.agent}.md`), prompt);
}

console.log(`
Runway ready: ${baseline}

1) Once, register ATC with Claude Code (the key is read from your shell; it is not printed here):
   export AGENTMESH_API_KEY=$(grep '^AGENTMESH_API_KEY=' ${join(ROOT, ".env")} | cut -d= -f2-)
   claude mcp add --scope user --transport http atc ${config.workerUrl}/mcp --header "Authorization: Bearer $AGENTMESH_API_KEY"

2) Watch the airspace (live; add ?replay afterwards to replay the recording):
   ${config.workerUrl}/r/${baseline}

3) Start one Claude Code session per agent, each in its own empty folder, and paste its prompt:
${tasks.map((t, i) => `   mkdir -p /tmp/atc/${t.agent} && cd /tmp/atc/${t.agent} && claude "$(cat ${join(outDir, `agent-${i + 1}-${t.agent}.md`)})"`).join("\n")}
`);

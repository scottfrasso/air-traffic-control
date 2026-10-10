/**
 * Milestone 3 check: declare_intent returns overlaps with in-flight work, and get_signals tells
 * the other agent "fork A is changing the signature of applyDiscount". Agent A uses the HTTP API;
 * agent B uses the MCP server, like a real coding agent would.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh, type ForkCredentials } from "../lib/agentmesh.ts";
import { Repo } from "../lib/git.ts";
import { say, waitFor } from "../lib/log.ts";
import { connectMcp } from "../lib/mcp.ts";
import { agentAChangeSignature, agentBAddCaller } from "../scenario.ts";
import { seed } from "../seed.ts";

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const baseline = await seed(`m3-${stamp}`);
const mesh = new Agentmesh(baseline);
const work = mkdtempSync(join(tmpdir(), "agentmesh-m3-"));
let failed = false;
const check = (ok: boolean, what: string) => {
  say(ok ? "check" : "fail", `${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const mcp = await connectMcp("agent-b");
try {
  const tools = await mcp.tools();
  check(["start_work", "declare_intent", "get_signals"].every((t) => tools.includes(t)), `MCP tools listed: ${tools.join(", ")}`);

  const a = await mesh.createFork("a");
  const b = JSON.parse(await mcp.call("start_work", { repo: baseline, agent: "b" })) as ForkCredentials;
  say("system", `forks ${a.fork} (HTTP) and ${b.fork} (MCP)`);

  const aIntent = await mesh.call<{ overlaps: unknown[] }>("POST", "/intents", {
    fork: a.fork, description: "Make discounts structured (percent or fixed)", files: ["src/pricing.ts", "src/cart.ts"], symbols: ["applyDiscount"],
  });
  check(aIntent.overlaps.length === 0, "A's intent: no overlaps yet");

  const ra = Repo.clone(a.remote, a.token, join(work, "a"), { name: "agent-a", email: "a@agentmesh.dev" });
  agentAChangeSignature(ra.dir);
  ra.commitAll("A: applyDiscount takes a Discount");
  ra.push(a.remote);
  say("A", "pushed signature change");
  await waitFor("A indexed", async () => (await mesh.state()).forks.find((f) => f.name === a.fork && f.processed_sha === f.head_sha && f.head_sha !== f.base_sha));

  const bIntentText = await mcp.call("declare_intent", {
    fork: b.fork, description: "Add member pricing at checkout", files: ["src/checkout.ts"], symbols: ["applyDiscount"],
  });
  const bIntent = JSON.parse(bIntentText) as { overlaps: Array<{ fork: string; reason: string }> };
  check(bIntent.overlaps.some((o) => o.fork === a.fork && /applyDiscount/.test(o.reason)), `B's intent (MCP) reports overlap: ${bIntent.overlaps.map((o) => `${o.fork} ${o.reason}`).join("; ")}`);

  const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "agent-b", email: "b@agentmesh.dev" });
  agentBAddCaller(rb.dir);
  rb.commitAll("B: member pricing at checkout");
  rb.push(b.remote);
  say("B", "pushed new caller");

  const bSignals = await waitFor("signature_change signal to B", async () => {
    const out = await mcp.call("get_signals", { fork: b.fork });
    return /changing the signature of applyDiscount/.test(out) && /you use it in src\/checkout\.ts/.test(out) ? out : null;
  });
  check(true, "B got signature-change signal via MCP get_signals");
  for (const s of JSON.parse(bSignals) as Array<{ kind: string; message: string }>) say("B", `signal [${s.kind}] ${s.message}`);

  const aSignals = await mesh.call<Array<{ kind: string; message: string }>>("GET", `/signals?fork=${a.fork}`);
  check(aSignals.some((s) => s.kind === "signature_change" && s.message.includes(b.fork)), "A learns B depends on applyDiscount");
  for (const s of aSignals) say("A", `signal [${s.kind}] ${s.message}`);
  say("system", `dashboard: https://agentmesh.scottfrasso.workers.dev/r/${baseline}`);
  await Promise.all([mesh.abandon(a.fork), mesh.abandon(b.fork)]);
} finally {
  await mcp.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

/**
 * Acceptance test (prompt.md), end to end against deployed Cloudflare resources, no manual steps:
 *   1. Agent A forks the repo and changes a function's signature.
 *   2. Agent B forks the repo and adds a new caller of that function in a different file.
 *   3. Plain git reports no conflict between the two forks.
 *   4. The system emits a semantic-conflict signal to both before either requests landing.
 *   5. A requests landing and merges. B is told to rebase, fixes the call, and lands.
 *   6. Baseline typechecks at the end.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh, type Signal } from "./lib/agentmesh.ts";
import { config, ROOT } from "./lib/env.ts";
import { Repo } from "./lib/git.ts";
import { say, sleep, waitFor } from "./lib/log.ts";
import { agentAChangeSignature, agentBAddCaller, agentBFixCaller } from "./scenario.ts";
import { seed } from "./seed.ts";

type LandResponse = { landed: boolean; reason?: string; retry?: boolean; baselineHead?: string; rebaseRequired?: string[] };

const step = (n: number, title: string) => console.log(`\n\x1b[1m── ${n}. ${title}\x1b[0m`);
let failed = false;
const check = (ok: boolean, what: string) => {
  say(ok ? "check" : "fail", `${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
  return ok;
};

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const work = mkdtempSync(join(tmpdir(), "agentmesh-demo-"));
const baseline = await seed(`shop-${stamp}`);
const mesh = new Agentmesh(baseline);
say("system", `dashboard: ${config.workerUrl}/r/${baseline}`);

const openSignals = async (fork: string) => mesh.call<Signal[]>("GET", `/signals?fork=${fork}`);
const land = async (who: "A" | "B", fork: string): Promise<LandResponse> => {
  for (;;) {
    const res = await mesh.call<LandResponse>("POST", "/land", { fork });
    if (!res.retry) return res;
    say(who, `land: ${res.reason}`);
    await sleep(3000);
  }
};

try {
  step(1, "Agent A forks and changes applyDiscount's signature");
  const a = await mesh.createFork("a");
  const ra = Repo.clone(a.remote, a.token, join(work, "a"), { name: "agent-a", email: "a@agentmesh.dev" });
  await mesh.call("POST", "/intents", { fork: a.fork, description: "Make discounts structured (percent or fixed)", files: ["src/pricing.ts", "src/cart.ts"], symbols: ["applyDiscount"] });
  agentAChangeSignature(ra.dir);
  ra.commitAll("Make applyDiscount take a Discount");
  ra.push(a.remote);
  say("A", `pushed ${ra.head().slice(0, 7)} to ${a.fork}: applyDiscount(price, percent) → applyDiscount(price, discount: Discount)`);

  step(2, "Agent B forks and adds a new caller in a different file");
  const b = await mesh.createFork("b");
  const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "agent-b", email: "b@agentmesh.dev" }, { [b.baselineRemote]: b.baselineToken, [a.remote]: a.token });
  agentBAddCaller(rb.dir);
  rb.commitAll("Add member pricing at checkout");
  rb.push(b.remote);
  say("B", `pushed ${rb.head().slice(0, 7)} to ${b.fork}: new src/checkout.ts calls applyDiscount(price, 15)`);
  const pushedAt = Date.now();

  step(3, "Plain git reports no conflict between the two forks");
  const probe = Repo.clone(b.remote, b.token, join(work, "probe"), { name: "probe", email: "probe@agentmesh.dev" }, { [a.remote]: a.token });
  const aHead = probe.fetch(a.remote);
  const merge = probe.git(["merge", "--no-edit", aHead], { allowFail: true });
  check(merge.ok, `git merge of ${a.fork} into ${b.fork}: ${merge.ok ? "clean, no conflicts" : merge.out}`);

  step(4, "The system emits a semantic-conflict signal to both agents, before anyone requests landing");
  const [sa, sb] = await waitFor("semantic_conflict signals to both agents", async () => {
    const [x, y] = await Promise.all([openSignals(a.fork), openSignals(b.fork)]);
    const fx = x.find((s) => s.kind === "semantic_conflict");
    const fy = y.find((s) => s.kind === "semantic_conflict");
    return fx && fy ? ([fx, fy] as const) : null;
  }, 240_000, 2000);
  say("A", `signal: ${sa.message}`);
  say("B", `signal: ${sb.message}`);
  check(sa.symbol === "applyDiscount" && sb.symbol === "applyDiscount" && sa.about_fork === b.fork && sb.about_fork === a.fork, `both signals name applyDiscount and the other fork (${((Date.now() - pushedAt) / 1000).toFixed(0)}s after push)`);
  const before = await mesh.state();
  check(!before.events.some((e) => e.kind === "land.requested"), "no landing had been requested yet");

  step(5, "A requests landing and merges; B is told to rebase, fixes the call, and lands");
  const aLand = await land("A", a.fork);
  check(aLand.landed, `A landed: ${aLand.landed ? `baseline is now ${aLand.baselineHead?.slice(0, 7)}` : aLand.reason}`);
  const rebase = await waitFor("rebase_required to B", async () => (await openSignals(b.fork)).find((s) => s.kind === "rebase_required"), 30_000);
  say("B", `signal: ${rebase.message}`);
  const early = await land("B", b.fork);
  check(!early.landed, `B's landing before rebasing is refused: ${early.reason}`);

  const baseHead = rb.fetch(b.baselineRemote);
  rb.git(["merge", "--no-edit", "-q", baseHead]);
  say("B", `merged baseline ${baseHead.slice(0, 7)} into ${b.fork}`);
  agentBFixCaller(rb.dir);
  rb.commitAll("Use structured Discount at checkout");
  rb.push(b.remote);
  say("B", `pushed fix ${rb.head().slice(0, 7)}: applyDiscount(price, { kind: "percent", value: 15 })`);
  const bLand = await land("B", b.fork);
  check(bLand.landed, `B landed: ${bLand.landed ? `baseline is now ${bLand.baselineHead?.slice(0, 7)}` : bLand.reason}`);

  step(6, "Baseline typechecks at the end");
  const final = Repo.clone(a.baselineRemote, a.baselineToken, join(work, "final"), { name: "verify", email: "verify@agentmesh.dev" });
  const tsc = join(ROOT, "demo/node_modules/.bin/tsc");
  let ok = true;
  try {
    execFileSync(tsc, ["--noEmit", "-p", "."], { cwd: final.dir, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    ok = false;
    say("fail", String((err as { stdout?: Buffer }).stdout ?? err));
  }
  check(ok, `tsc --noEmit on baseline ${final.head().slice(0, 7)}`);
  const checkout = readFileSync(join(final.dir, "src/checkout.ts"), "utf8");
  check(readFileSync(join(final.dir, "src/pricing.ts"), "utf8").includes("discount: Discount") && checkout.includes('kind: "percent"'), "baseline contains A's signature change and B's fixed caller");
  say("system", `git log on baseline:\n${final.git(["log", "--oneline", "-6"]).out.split("\n").map((l) => `           ${l}`).join("\n")}`);
} catch (err) {
  failed = true;
  say("fail", (err as Error).message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failed ? "\x1b[31mDEMO FAILED" : "\x1b[32mDEMO PASSED"}\x1b[0m  dashboard: ${config.workerUrl}/r/${baseline}`);
process.exit(failed ? 1 : 0);

/**
 * Acceptance test (prompt.md), end to end against deployed Cloudflare resources, no manual steps:
 *   1. Agent A forks the repo and changes a function's signature.
 *   2. Agent B forks the repo and adds a new caller of that function in a different file.
 *   3. Plain git reports no conflict between the two forks.
 *   4. The system emits a semantic-conflict signal to both before either requests landing.
 *   5. A requests landing and merges. B is told to rebase, fixes the call, and lands.
 *   6. Baseline typechecks at the end.
 * Then: every landed PR's flight log is a git note on main (refs/notes/atc), and the run's savings in numbers.
 * --review: the review gate is on (issue #16). Each PR waits in REVIEW until a scripted reviewer approves its latest push.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh, type Signal } from "./lib/agentmesh.ts";
import { config, ROOT } from "./lib/env.ts";
import { Repo } from "./lib/git.ts";
import { say, sleep, waitFor } from "./lib/log.ts";
import { agentAChangeSignature, agentBAddCaller, agentBFixCaller, TRAFFIC } from "./scenario.ts";
import { seed } from "./seed.ts";
import { savingsLine } from "../../worker/src/savings.ts";

type LandResponse = { landed: boolean; reason?: string; retry?: boolean; baselineHead?: string; rebaseRequired?: string[]; atc?: string };
const withTraffic = !process.argv.includes("--no-traffic");
const withReview = process.argv.includes("--review");
const reviewed = new Map<string, string>(); // fork → the head the scripted reviewer approved

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
if (withReview) {
  await mesh.call("POST", "/settings", { review: true });
  say("system", "review gate on: every PR waits in REVIEW until a reviewer approves its latest push");
}

const openSignals = async (fork: string) => mesh.call<Signal[]>("GET", `/signals?fork=${fork}`);
const land = async (who: "A" | "B", fork: string): Promise<LandResponse> => {
  for (;;) {
    const res = await mesh.call<LandResponse>("POST", "/land", { fork });
    if (!res.retry) return res;
    if (withReview && res.reason?.startsWith("Waiting for review")) {
      // The scripted reviewer: the PR is shown as REVIEW until it approves this exact head.
      const entry = ((await mesh.state()).sequence ?? []).find((e) => e.fork === fork);
      const head = (await mesh.state()).forks.find((f) => f.name === fork)?.head_sha ?? "";
      if (entry?.clearance === "review" && reviewed.get(fork) !== head) {
        say("system", `${entry.pr} REVIEW: ${entry.reason}`);
        await mesh.call("POST", "/reviews", { fork, verdict: "approve", reviewer: "reviewer-bot", note: "Scripted review: read the diff; it typechecks on main." });
        reviewed.set(fork, head);
        say("system", `reviewer-bot approved ${entry.pr} at ${head.slice(0, 7)}`);
        continue;
      }
    }
    say(who === "B" && !fork.endsWith(`--pr2`) ? "system" : who, `${fork.split("--").pop()?.toUpperCase()} land: ${res.reason}`);
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
  say("A", `PR${a.pr} pushed ${ra.head().slice(0, 7)}: applyDiscount(price, percent) → applyDiscount(price, discount: Discount)`);

  step(2, "Agent B forks and adds a new caller in a different file");
  const b = await mesh.createFork("b");
  const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "agent-b", email: "b@agentmesh.dev" }, { [b.baselineRemote]: b.baselineToken, [a.remote]: a.token });
  agentBAddCaller(rb.dir);
  rb.commitAll("Add member pricing at checkout");
  rb.push(b.remote);
  say("B", `PR${b.pr} pushed ${rb.head().slice(0, 7)}: new src/checkout.ts calls applyDiscount(price, 15)`);
  const pushedAt = Date.now();

  // Background traffic: more agents with independent PRs, so ATC has a real sequence to manage.
  const traffic = withTraffic
    ? await Promise.all(
        TRAFFIC.map(async (t) => {
          const creds = await mesh.createFork(t.agent);
          const repo = Repo.clone(creds.remote, creds.token, join(work, t.agent), { name: `agent-${t.agent}`, email: `${t.agent}@agentmesh.dev` }, { [creds.baselineRemote]: creds.baselineToken });
          t.apply(repo.dir);
          repo.commitAll(t.title);
          repo.push(creds.remote);
          say("system", `PR${creds.pr} (agent ${t.agent.toUpperCase()}) pushed: ${t.title}`);
          return { creds, repo };
        }),
      )
    : [];

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
  const seq = (await mesh.state()).sequence ?? [];
  for (const e of seq) say("system", `ATC #${e.position} ${e.pr} ${e.clearance.toUpperCase()}: ${e.reason}`);
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

  if (traffic.length) {
    step(6, "The other PRs land in ATC's sequence: no rebases (ATC merges each onto main and re-checks it)");
    const rebaseTold = new Set<string>();
    for (const t of traffic) if ((await mesh.call<Signal[]>("GET", `/signals?fork=${t.creds.fork}&all=1`)).some((s) => s.kind === "rebase_required")) rebaseTold.add(t.creds.fork);
    check(rebaseTold.size === 0, `no traffic PR was told to rebase when PR${a.pr} landed (only the conflicting PR${b.pr} went around)`);
    const order = ((await mesh.state()).sequence ?? []).map((e) => e.fork);
    traffic.sort((x, y) => order.indexOf(x.creds.fork) - order.indexOf(y.creds.fork));
    for (const { creds } of traffic) {
      const res = await land("B", creds.fork);
      check(res.landed, `PR${creds.pr} landed without rebasing: ${res.landed ? `main is now ${res.baselineHead?.slice(0, 7)}` : res.reason}`);
    }
  }

  step(7, "Baseline typechecks at the end");
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
  if (traffic.length) check(["src/shipping.ts"].every((f) => existsSync(join(final.dir, f))) && readFileSync(join(final.dir, "src/money.ts"), "utf8").includes("formatCentsCompact"), "baseline contains all traffic PRs");
  say("system", `git log on baseline:\n${final.git(["log", "--oneline", "-6"]).out.split("\n").map((l) => `           ${l}`).join("\n")}`);

  step(8, "Every landed PR's flight log is a git note on main (refs/notes/atc)");
  // ATC writes notes right after answering the landing request, so give the last one a moment.
  const end = await waitFor("flight log notes in git", async () => {
    const st = await mesh.state();
    return st.forks.filter((f) => f.status === "landed").every((f) => st.flightLogs?.some((l) => l.fork === f.name && l.noted)) ? st : null;
  }, 60_000, 1000).catch(() => mesh.state());
  final.git(["fetch", "-q", a.baselineRemote, "refs/notes/atc:refs/notes/atc"], { remote: a.baselineRemote });
  const landedForks = end.forks.filter((f) => f.status === "landed");
  const logs = end.flightLogs ?? [];
  for (const f of landedForks) {
    const log = logs.find((l) => l.fork === f.name);
    const note = log ? final.git(["notes", "--ref=atc", "show", log.landedSha], { allowFail: true }) : { ok: false, out: "" };
    check(!!log && note.ok && note.out.includes("ATC-Clearance:") && note.out === log.note, `${log?.pr ?? f.name} has its flight log on ${log?.landedSha.slice(0, 7) ?? "?"}`);
  }
  const bNote = logs.find((l) => l.fork === b.fork)?.note ?? "";
  if (withReview) {
    check(landedForks.length > 0 && landedForks.every((f) => reviewed.has(f.name)), `every landed PR waited in REVIEW and was approved first (${reviewed.size} reviews)`);
    check(logs.every((l) => /^ATC-Review: approved by reviewer-bot/m.test(l.note)), "each flight log records its approval");
  }
  check(/^ATC-Signal: semantic_conflict with PR\d+ on applyDiscount$/m.test(bNote) && /^ATC-Go-Around: /m.test(bNote), `PR${b.pr}'s log records the conflict and the go-around`);
  say("system", `git log --notes=atc -1 ${logs.find((l) => l.fork === b.fork)?.landedSha.slice(0, 7) ?? ""}:\n${final.git(["log", "--notes=atc", "-1", "--format=%h %s%n%N", logs.find((l) => l.fork === b.fork)?.landedSha ?? "HEAD"]).out.split("\n").map((l) => `           ${l}`).join("\n")}`);

  if (end.savings) {
    const s = end.savings;
    say("system", `savings: ${savingsLine(s)}`);
    const avgPair = s.pairCheckMs?.length ? (s.pairCheckMs.reduce((x, y) => x + y, 0) / s.pairCheckMs.length / 1000).toFixed(1) : "-";
    say("system", `         main state built ${s.mainBuilds ?? "-"}×, avg pair check ${avgPair} s`);
    say("system", `         typecheck cache hits ${s.cacheHits}/${s.typechecks}, avg wait to land ${s.waitMs.length ? Math.round(s.waitMs.reduce((x, y) => x + y, 0) / s.waitMs.length / 1000) : 0} s, run ${Math.round(s.elapsedMs / 1000)} s`);
  }
} catch (err) {
  failed = true;
  say("fail", (err as Error).message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failed ? "\x1b[31mDEMO FAILED" : "\x1b[32mDEMO PASSED"}\x1b[0m  dashboard: ${config.workerUrl}/r/${baseline}`);
process.exit(failed ? 1 : 0);

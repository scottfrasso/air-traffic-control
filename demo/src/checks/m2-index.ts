/**
 * Milestone 2 check: pushes to two forks show up in the in-flight index with touched files,
 * exported-symbol changes, and file + symbol overlaps.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh } from "../lib/agentmesh.ts";
import { Repo } from "../lib/git.ts";
import { say, waitFor } from "../lib/log.ts";
import { agentAChangeSignature, agentBAddCaller } from "../scenario.ts";
import { seed } from "../seed.ts";

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const baseline = await seed(`m2-${stamp}`);
const mesh = new Agentmesh(baseline);
const work = mkdtempSync(join(tmpdir(), "agentmesh-m2-"));
let failed = false;
const check = (ok: boolean, what: string) => {
  say(ok ? "check" : "fail", `${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

try {
  const [a, b] = await Promise.all([mesh.createFork("a"), mesh.createFork("b")]);
  say("system", `forks ${a.fork}, ${b.fork}`);

  const ra = Repo.clone(a.remote, a.token, join(work, "a"), { name: "agent-a", email: "a@agentmesh.dev" });
  agentAChangeSignature(ra.dir);
  appendFileSync(join(ra.dir, "README.md"), "\nA was here.\n");
  ra.commitAll("A: applyDiscount takes a Discount");
  ra.push(a.remote);
  say("A", `pushed ${ra.head().slice(0, 7)}`);

  const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "agent-b", email: "b@agentmesh.dev" });
  agentBAddCaller(rb.dir);
  appendFileSync(join(rb.dir, "README.md"), "\nB was here.\n");
  rb.commitAll("B: member pricing at checkout");
  rb.push(b.remote);
  say("B", `pushed ${rb.head().slice(0, 7)}`);

  const t0 = Date.now();
  const state = await waitFor("both forks indexed", async () => {
    const s = await mesh.state();
    const done = s.forks.filter((f) => f.processed_sha === f.head_sha && f.head_sha !== f.base_sha);
    return done.length === 2 ? s : null;
  }, 120_000);
  say("system", `both forks indexed after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const fa = state.forks.find((f) => f.name === a.fork)!;
  const fb = state.forks.find((f) => f.name === b.fork)!;
  check(JSON.stringify(fa.files.map((f) => f.path).sort()) === JSON.stringify(["README.md", "src/cart.ts", "src/pricing.ts"]), `A touched files: ${fa.files.map((f) => f.path).join(", ")}`);
  check(JSON.stringify(fb.files.map((f) => `${f.path}:${f.change}`).sort()) === JSON.stringify(["README.md:modified", "src/checkout.ts:added"]), `B touched files: ${fb.files.map((f) => `${f.path}:${f.change}`).join(", ")}`);
  check(fa.symbols.some((s) => s.name === "applyDiscount" && s.change === "signature_changed"), "A: applyDiscount signature_changed");
  check(fa.symbols.some((s) => s.name === "Discount" && s.change === "added"), "A: Discount added");
  check(fb.symbols.some((s) => s.name === "memberPrice" && s.change === "added"), "B: memberPrice added");
  check(state.overlaps.some((o) => o.kind === "file" && o.path === "README.md"), "file overlap on README.md");
  check(state.overlaps.some((o) => o.kind === "symbol" && o.symbol === "applyDiscount"), "symbol overlap on applyDiscount");
  for (const o of state.overlaps) say("system", `overlap: ${o.detail}`);
  const sources = state.events.filter((e) => e.kind === "push.received").map((e) => `${e.fork}:${(e.detail as { source: string }).source}`);
  say("system", `push detection: ${sources.join(", ")}`);
  say("system", `dashboard: https://agentmesh.scottfrasso.workers.dev/r/${baseline}`);

  await Promise.all([mesh.abandon(a.fork), mesh.abandon(b.fork)]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

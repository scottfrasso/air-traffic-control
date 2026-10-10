/**
 * The submission video's recorded run, on demo/sample-booking, with five PRs:
 *   PR1 (A) changes createBooking's parameters. PR2 (B) adds a new caller the old way. PR3–PR5 are independent.
 *   1. Everyone pushes. ATC merges every pair and typechecks; only PR1 + PR2 fails together.
 *   2. ATC orders the landing: PR2 is the smaller change, so PR1 holds behind it, and is told so while still working.
 *   3. PR1's agent pulls in PR2 and updates the new call, then pushes again.
 *   4. Everyone lands in ATC's order. Nobody is told to rebase. Main typechecks.
 * Writes what the video shows (timings, pair checks, the real tsc error, clearances, diff sizes) to video/src/data/run.json.
 *
 *   tsx src/video-run.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh, type ForkCredentials, type Signal } from "./lib/agentmesh.ts";
import { config, ROOT } from "./lib/env.ts";
import { Repo } from "./lib/git.ts";
import { say, sleep, waitFor } from "./lib/log.ts";
import { agentAAddNights, agentAFixWalkIn, agentBAddWalkIn, BOOKING_TRAFFIC } from "./booking-scenario.ts";
import { seed } from "./seed.ts";

type LandResponse = { landed: boolean; reason?: string; retry?: boolean; baselineHead?: string };
type Timeline = {
  snapshots: Array<{ at: number; state: { sequence?: Array<{ pr: string; clearance: string; reason: string }>; forks?: Array<{ name: string; diff_lines: number; symbols?: Array<{ name: string; change: string }> }> } }>;
  events: Array<{ id: number; at: number; kind: string; fork: string | null; detail: Record<string, unknown> }>;
};

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const work = mkdtempSync(join(tmpdir(), "agentmesh-video-"));
const baseline = await seed(`booking-${stamp}`, "demo/sample-booking");
const mesh = new Agentmesh(baseline);
say("system", `dashboard: ${config.workerUrl}/r/${baseline}`);
const signals = (fork: string, all = false) => mesh.call<Signal[]>("GET", `/signals?fork=${fork}${all ? "&all=1" : ""}`);
const settled = async () => {
  const seq = (await mesh.state()).sequence ?? [];
  return seq.length > 0 && !seq.some((e) => e.clearance === "checking") ? seq : null;
};

try {
  const a = await mesh.createFork("a");
  const b = await mesh.createFork("b");
  const traffic: Array<{ creds: ForkCredentials; repo: Repo; title: string; apply: (dir: string) => void }> = [];
  for (const t of BOOKING_TRAFFIC) {
    const creds = await mesh.createFork(t.agent);
    traffic.push({ creds, repo: Repo.clone(creds.remote, creds.token, join(work, t.agent), { name: `agent-${t.agent}`, email: `${t.agent}@agentmesh.dev` }), ...t });
  }
  const ra = Repo.clone(a.remote, a.token, join(work, "a"), { name: "agent-a", email: "a@agentmesh.dev" }, { [b.remote]: b.token });
  const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "agent-b", email: "b@agentmesh.dev" });

  agentAAddNights(ra.dir);
  ra.commitAll("Add nights to createBooking");
  ra.push(a.remote);
  say("A", `PR${a.pr} pushed: createBooking(guest, room) → createBooking(guest, room, nights)`);
  agentBAddWalkIn(rb.dir);
  rb.commitAll("Add walk-in bookings");
  rb.push(b.remote);
  say("B", `PR${b.pr} pushed: new src/walk-in.ts calls createBooking(guest, freeRoom)`);
  for (const t of traffic) {
    t.apply(t.repo.dir);
    t.repo.commitAll(t.title);
    t.repo.push(t.creds.remote);
    say("system", `PR${t.creds.pr} pushed: ${t.title}`);
  }

  const sa = await waitFor("semantic conflict to A", async () => (await signals(a.fork)).find((s) => s.kind === "semantic_conflict"), 240_000, 1000);
  say("A", `signal: ${sa.message}`);
  const seq1 = await waitFor("all pair checks settled", settled, 240_000, 1000);
  for (const e of seq1) say("system", `ATC #${e.position} ${e.pr} ${e.clearance.toUpperCase()}: ${e.reason}`);
  const hold = seq1.find((e) => e.fork === a.fork);
  if (hold?.clearance !== "hold") throw new Error(`expected PR${a.pr} to hold, got ${hold?.clearance}`);
  await sleep(4000); // let the board sit, so the recording shows it

  // PR1 is told to hold behind PR2: its agent pulls in PR2 and updates the new call while still working.
  ra.git(["merge", "--no-edit", "-q", ra.fetch(b.remote)]);
  agentAFixWalkIn(ra.dir);
  ra.commitAll("Pass nights for walk-ins");
  ra.push(a.remote);
  say("A", `merged PR${b.pr} and pushed: walk-in now calls createBooking(guest, freeRoom, 1)`);
  await waitFor("conflict resolved", async () => !(await signals(a.fork)).some((s) => s.kind === "semantic_conflict"), 240_000, 1000);
  const seq2 = await waitFor("checks settled after the fix", settled, 240_000, 1000);
  for (const e of seq2) say("system", `ATC #${e.position} ${e.pr} ${e.clearance.toUpperCase()}: ${e.reason}`);

  // Land everyone in ATC's order: always whoever is #1.
  const order: string[] = [];
  for (let i = 0; i < 5; i++) {
    const next = await waitFor("a cleared PR", async () => (await settled())?.[0], 240_000, 1000);
    for (;;) {
      const res = await mesh.call<LandResponse>("POST", "/land", { fork: next.fork });
      if (res.landed) { say("check", `${next.pr} landed: main is ${res.baselineHead?.slice(0, 7)}`); break; }
      if (!res.retry) throw new Error(`${next.pr} land refused: ${res.reason}`);
      await sleep(2000);
    }
    order.push(next.pr);
  }
  const rebased = [];
  for (const f of [a, b, ...traffic.map((t) => t.creds)]) if ((await signals(f.fork, true)).some((s) => s.kind === "rebase_required")) rebased.push(`PR${f.pr}`);
  say(rebased.length ? "fail" : "check", `told to rebase: ${rebased.join(", ") || "nobody"}`);

  const final = Repo.clone(a.baselineRemote, a.baselineToken, join(work, "final"), { name: "verify", email: "verify@agentmesh.dev" });
  execFileSync(join(ROOT, "demo/node_modules/.bin/tsc"), ["--noEmit", "-p", "."], { cwd: final.dir, stdio: ["ignore", "pipe", "pipe"] });
  say("check", `tsc --noEmit on main ${final.head().slice(0, 7)}: clean`);

  // Keep only what the video shows (no credentials are in the timeline, but stay minimal anyway).
  const tl = await mesh.call<Timeline>("GET", "/timeline");
  const t0 = tl.events.find((e) => e.kind === "push.received")?.at ?? tl.events[0]?.at ?? 0;
  const prOf = (fork: unknown) => String(fork ?? "").split("--").pop()?.toUpperCase() ?? null;
  const events = tl.events.map((e) => ({
    t: (e.at - t0) / 1000,
    kind: e.kind,
    pr: e.fork ? prOf(e.fork) : null,
    detail: e.kind === "check.pair" ? { a: prOf(e.detail.a), b: prOf(e.detail.b), status: e.detail.status, fresh: e.detail.fresh, symbol: e.detail.symbol, errors: e.detail.errors } : null,
  }));
  const sequences = tl.snapshots.map((s) => ({ t: (s.at - t0) / 1000, sequence: (s.state.sequence ?? []).map((x) => ({ pr: x.pr, clearance: x.clearance, reason: x.reason })) }));
  const firstSettled = tl.snapshots.find((s) => (s.state.sequence ?? []).some((x) => x.clearance === "hold"));
  const forks = (firstSettled?.state.forks ?? []).map((f) => ({ pr: prOf(f.name), diff: f.diff_lines, symbols: (f.symbols ?? []).map((x) => `${x.name}:${x.change}`) }));
  const out = { baseline, recordedAt: new Date().toISOString(), a: `PR${a.pr}`, b: `PR${b.pr}`, traffic: traffic.map((t) => ({ pr: `PR${t.creds.pr}`, title: t.title })), signalToA: sa.message, order, rebased, forks, events, sequences };
  mkdirSync(join(ROOT, "video/src/data"), { recursive: true });
  writeFileSync(join(ROOT, "video/src/data/run.json"), JSON.stringify(out, null, 2));
  say("system", `wrote video/src/data/run.json (${tl.events.length} events)`);
  if (rebased.length) throw new Error("someone was told to rebase");
  console.log("\n\x1b[32mVIDEO RUN PASSED\x1b[0m");
} finally {
  rmSync(work, { recursive: true, force: true });
}

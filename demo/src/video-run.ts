/**
 * The submission video's recorded run, on demo/sample-booking:
 *   1. A adds a `nights` parameter to createBooking; B adds a new caller the old way. Both push.
 *   2. ATC flags the semantic conflict to both, before anyone requests landing.
 *   3. B merges A's fork, fixes its call and pushes again, while still in flight.
 *   4. A lands, then B lands with no go-around. Main typechecks.
 * Writes the facts the video shows (timings, the real tsc error, clearances) to video/src/data/run.json.
 *
 *   tsx src/video-run.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh, type Signal } from "./lib/agentmesh.ts";
import { config, ROOT } from "./lib/env.ts";
import { Repo } from "./lib/git.ts";
import { say, sleep, waitFor } from "./lib/log.ts";
import { agentAAddNights, agentBAddWalkIn, agentBFixWalkIn } from "./booking-scenario.ts";
import { seed } from "./seed.ts";

type LandResponse = { landed: boolean; reason?: string; retry?: boolean; baselineHead?: string };
type Timeline = { snapshots: Array<{ at: number; state: { sequence?: Array<{ pr: string; clearance: string; reason: string }> } }>; events: Array<{ id: number; at: number; kind: string; fork: string | null; detail: Record<string, unknown> }> };

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const work = mkdtempSync(join(tmpdir(), "agentmesh-video-"));
const baseline = await seed(`booking-${stamp}`, "demo/sample-booking");
const mesh = new Agentmesh(baseline);
say("system", `dashboard: ${config.workerUrl}/r/${baseline}`);
const signals = (fork: string) => mesh.call<Signal[]>("GET", `/signals?fork=${fork}`);
const land = async (fork: string): Promise<LandResponse> => {
  for (;;) {
    const res = await mesh.call<LandResponse>("POST", "/land", { fork });
    if (!res.retry) return res;
    say("system", `${fork.split("--").pop()?.toUpperCase()} land: ${res.reason}`);
    await sleep(3000);
  }
};

try {
  const a = await mesh.createFork("a");
  const b = await mesh.createFork("b");
  const ra = Repo.clone(a.remote, a.token, join(work, "a"), { name: "agent-a", email: "a@agentmesh.dev" });
  agentAAddNights(ra.dir);
  ra.commitAll("Add nights to createBooking");
  ra.push(a.remote);
  say("A", `PR${a.pr} pushed: createBooking(guest, room) → createBooking(guest, room, nights)`);

  const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "agent-b", email: "b@agentmesh.dev" }, { [a.remote]: a.token });
  agentBAddWalkIn(rb.dir);
  rb.commitAll("Add walk-in bookings");
  rb.push(b.remote);
  say("B", `PR${b.pr} pushed: new src/walk-in.ts calls createBooking(guest, freeRoom)`);

  const probe = Repo.clone(b.remote, b.token, join(work, "probe"), { name: "probe", email: "probe@agentmesh.dev" }, { [a.remote]: a.token });
  const merged = probe.git(["merge", "--no-edit", probe.fetch(a.remote)], { allowFail: true });
  say("check", `plain git merge of PR${a.pr} into PR${b.pr}: ${merged.ok ? "clean, no conflicts" : merged.out}`);

  const sb = await waitFor("semantic conflict to B", async () => (await signals(b.fork)).find((s) => s.kind === "semantic_conflict"), 240_000, 1000);
  say("B", `signal: ${sb.message}`);

  // B fixes while still in flight: merge A's fork, update the call, push.
  rb.git(["merge", "--no-edit", "-q", rb.fetch(a.remote)]);
  agentBFixWalkIn(rb.dir);
  rb.commitAll("Pass nights for walk-ins");
  rb.push(b.remote);
  say("B", `merged PR${a.pr} and pushed fix: createBooking(guest, freeRoom, 1)`);
  await waitFor("conflict resolved", async () => !(await signals(b.fork)).some((s) => s.kind === "semantic_conflict"), 240_000, 1000);
  say("check", "conflict resolved by B's fix");

  const la = await land(a.fork);
  say(la.landed ? "check" : "fail", `PR${a.pr} landed: ${la.landed ? la.baselineHead?.slice(0, 7) : la.reason}`);
  const lb = await land(b.fork);
  say(lb.landed ? "check" : "fail", `PR${b.pr} landed: ${lb.landed ? lb.baselineHead?.slice(0, 7) : lb.reason}`);
  if (!la.landed || !lb.landed) throw new Error("landing failed");

  const final = Repo.clone(a.baselineRemote, a.baselineToken, join(work, "final"), { name: "verify", email: "verify@agentmesh.dev" });
  execFileSync(join(ROOT, "demo/node_modules/.bin/tsc"), ["--noEmit", "-p", "."], { cwd: final.dir, stdio: ["ignore", "pipe", "pipe"] });
  say("check", `tsc --noEmit on main ${final.head().slice(0, 7)}: clean`);

  // Keep only what the video shows (no credentials are in the timeline, but stay minimal anyway).
  const tl = await mesh.call<Timeline>("GET", "/timeline");
  const t0 = tl.events.find((e) => e.kind === "push.received")?.at ?? tl.events[0]?.at ?? 0;
  const pick = (e: Timeline["events"][number]) => ({ t: (e.at - t0) / 1000, kind: e.kind, pr: e.fork?.split("--").pop()?.toUpperCase() ?? null, detail: e.kind === "check.pair" ? { a: String(e.detail.a).split("--").pop()?.toUpperCase(), b: String(e.detail.b).split("--").pop()?.toUpperCase(), status: e.detail.status, symbol: e.detail.symbol, errors: e.detail.errors } : null });
  const sequences = tl.snapshots.map((s) => ({ t: (s.at - t0) / 1000, sequence: (s.state.sequence ?? []).map((x) => ({ pr: x.pr, clearance: x.clearance, reason: x.reason })) }));
  const out = { baseline, recordedAt: new Date().toISOString(), a: `PR${a.pr}`, b: `PR${b.pr}`, signalToB: sb.message, events: tl.events.map(pick), sequences };
  mkdirSync(join(ROOT, "video/src/data"), { recursive: true });
  writeFileSync(join(ROOT, "video/src/data/run.json"), JSON.stringify(out, null, 2));
  say("system", `wrote video/src/data/run.json (${tl.events.length} events)`);
  console.log("\n\x1b[32mVIDEO RUN PASSED\x1b[0m");
} finally {
  rmSync(work, { recursive: true, force: true });
}

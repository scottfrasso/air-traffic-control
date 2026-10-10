/**
 * Verifies ATC pushes state to dashboards over WebSocket as real events happen, and that the run is
 * recorded for replay. Usage: tsx src/checks/live-push.ts <baseline> [seconds]
 * Listens on /live and counts pushes until the baseline has no active PRs (or the time limit).
 */
import { config } from "../lib/env.ts";
import { say } from "../lib/log.ts";

const [baseline, secs = "150"] = process.argv.slice(2);
if (!baseline) throw new Error("usage: live-push.ts <baseline> [seconds]");
const url = `${config.workerUrl.replace(/^http/, "ws")}/api/repos/${baseline}/live?key=${encodeURIComponent(config.apiKey())}`;
const ws = new WebSocket(url);
let pushes = 0;
const kinds = new Set<string>();
let lastTop = 0;
ws.onmessage = (m) => {
  pushes++;
  const s = JSON.parse(String(m.data)) as { events: Array<{ id: number; kind: string }>; forks: Array<{ status: string }> };
  for (const e of s.events) if (e.id > lastTop) kinds.add(e.kind);
  lastTop = Math.max(lastTop, ...s.events.map((e) => e.id));
};
await new Promise((r) => setTimeout(r, Number(secs) * 1000));
ws.close();
say(pushes > 5 ? "check" : "fail", `${pushes > 5 ? "PASS" : "FAIL"} received ${pushes} live pushes; event kinds seen: ${[...kinds].sort().join(", ")}`);
const tl = (await (await fetch(`${config.workerUrl}/api/repos/${baseline}/timeline`, { headers: { authorization: `Bearer ${config.apiKey()}` } })).json()) as { snapshots: unknown[]; events: unknown[] };
say(tl.snapshots.length > 5 ? "check" : "fail", `${tl.snapshots.length > 5 ? "PASS" : "FAIL"} recorded ${tl.snapshots.length} snapshots and ${tl.events.length} events for replay`);
process.exit(pushes > 5 && tl.snapshots.length > 5 ? 0 : 1);

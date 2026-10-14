/** How it's built on Cloudflare: one card per product saying what it does and why it matters. */
import type { Scene } from "../scene/draw";
import { clamp, glide, GROUND, HANGARS, LIVERY, SCALE, smooth, TOWER, type Plane } from "../scene/geometry";
import { C, PIXEL, Stage, TERM } from "../scene/Stage";
import { T } from "../timeline";
import { LIV, PRS, where } from "./RealRun";

const TRAFFIC = [
  { id: "f", pr: "PR6", s: 0.82 },
  { id: "a", pr: "PR7", s: 0.62 },
  { id: "b", pr: "PR8", s: 0.42 },
] as const;

export function Airport({ t }: { t: number }) {
  const parked: Plane[] = PRS.map((pr) => { const w = where(pr, t); return { id: pr, x: w.p[0], y: w.p[1], face: w.face, livery: LIV[pr]! }; });
  // New traffic: more agents start work and fly in to their slots (illustration).
  const traffic = TRAFFIC.map((x, i) => {
    const s = x.s - 0.6 * (1 - smooth(clamp((t - T.b5 - i * 0.8) / 4)));
    const [px, py] = glide(s);
    return { ...x, l: { phase: "approach" as const }, plane: { id: x.id, x: px, y: py, face: 1, livery: LIVERY[x.id] } as Plane };
  });
  const pushPulse = traffic.map((x, i) => {
    const phase = (t * 0.7 + i * 0.27) % 1;
    return { from: [x.plane.x, x.plane.y] as [number, number], to: [TOWER.x, TOWER.top - 4] as [number, number], color: C.cyan, progress: phase };
  });
  const inDurable = t >= T.durableVo && t < T.sandboxVo;
  const inSandbox = t >= T.sandboxVo && t < T.workerVo;
  const scene: Scene = {
    t,
    planes: [...parked, ...traffic.map((x) => x.plane)],
    beams: inDurable ? pushPulse : [],
    towerLight: inDurable && Math.floor(t * 3) % 2 === 0 ? C.cyan : undefined,
    checkLight: inSandbox ? (Math.floor(t * 3) % 2 ? C.green : "#2f8a45") : undefined,
  };
  const starts = [T.airportVo + 2.2, T.durableVo + 0.8, T.sandboxVo + 0.8, T.workerVo + 0.6];
  const current = starts.filter((x) => t >= x).length - 1;
  const glow = current === 0 ? clamp((t - starts[0]!) / 0.4) * (0.5 + 0.5 * Math.sin(t * 4)) : 0;
  return (
    <Stage scene={scene}>
      <>
        {HANGARS.map((hx) => (
          <div key={hx} style={{ position: "absolute", left: (hx - 3) * SCALE, top: (GROUND - 29) * SCALE, width: 50 * SCALE, height: 30 * SCALE, boxShadow: `0 0 40px 12px rgba(250,174,64,${0.5 * glow})`, background: `rgba(250,174,64,${0.12 * glow})` }} />
        ))}
        <div style={{ position: "absolute", left: 48, top: 40, font: `22px/1 ${PIXEL}`, color: C.orange, opacity: clamp((t - T.airportVo) / 0.4) }}>BUILT ON CLOUDFLARE</div>
        <div style={{ position: "absolute", left: 960, top: 84, transform: "translateX(-50%)", width: 1400, display: "flex", flexDirection: "column", gap: 14 }}>
          {CARDS.map((c, i) => t >= starts[i]! && <Card key={c.title} n={i + 1} {...c} opacity={clamp((t - starts[i]!) / 0.4)} active={i === current} />)}
        </div>
      </>
    </Stage>
  );
}

const CARDS = [
  { title: "ARTIFACTS", color: C.amber, what: "A Git fork for every agent.", why: "Agents work in parallel, and every push is an event ATC reacts to right away." },
  { title: "DURABLE OBJECT", color: C.cyan, what: "One per repo: every open PR, its check results, and the landing order.", why: "Recomputes the order the moment anything changes. Every agent gets the same answer." },
  { title: "SANDBOX", color: C.green, what: "Containers that run the test merges and builds, isolated from ATC.", why: "Fast: main is built once, only what changed is re-checked, results are cached." },
  { title: "WORKER + WORKFLOWS", color: C.orange, what: "One Worker: the MCP server agents talk to, the API, this dashboard.", why: "Each push runs as a Workflow, so a check that fails halfway is retried, not lost." },
];

function Card({ n, title, color, what, why, opacity, active }: { n: number; title: string; color: string; what: string; why: string; opacity: number; active: boolean }) {
  return (
    <div style={{ opacity, display: "grid", gridTemplateColumns: "90px 1fr", padding: "14px 28px 12px", background: "rgba(15,21,48,0.95)", border: `6px solid ${active ? color : C.edge}`, boxShadow: "8px 8px 0 #0f1530" }}>
      <div style={{ font: `56px/1 ${PIXEL}`, color }}>{n}</div>
      <div>
        <div style={{ font: `28px/1.2 ${PIXEL}`, color }}>{title}</div>
        <div style={{ font: `38px/1.15 ${TERM}`, color: C.text, marginTop: 10 }}>{what}</div>
        <div style={{ font: `36px/1.15 ${TERM}`, color: active ? C.amber : C.dim, marginTop: 4 }}>{why}</div>
      </div>
    </div>
  );
}


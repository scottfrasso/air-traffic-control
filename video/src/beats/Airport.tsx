/** Beat 5: how it's built on Cloudflare, one card per product saying what it does and why it matters; then the close. */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import { clamp, glide, GROUND, HANGARS, LIVERY, SCALE, smooth, TOWER, type Plane } from "../scene/geometry";
import { C, PIXEL, Stage, TERM } from "../scene/Stage";
import { RUN, T } from "../timeline";
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
  const inSandbox = t >= T.sandboxVo;
  const scene: Scene = {
    t,
    planes: [...parked, ...traffic.map((x) => x.plane)],
    beams: inDurable ? pushPulse : [],
    towerLight: inDurable && Math.floor(t * 3) % 2 === 0 ? C.cyan : undefined,
    checkLight: inSandbox ? (Math.floor(t * 3) % 2 ? C.green : "#2f8a45") : undefined,
  };
  const closing = t >= T.closeStart;
  const card = t < T.durableVo ? 0 : t < T.sandboxVo ? 1 : 2;
  const from = [T.airportVo + 2.2, T.durableVo, T.sandboxVo][card]!;
  const glow = card === 0 && t >= from ? clamp((t - from) / 0.4) * (0.5 + 0.5 * Math.sin(t * 4)) : 0;
  return (
    <Stage scene={scene}>
      {!closing && (
        <>
          {HANGARS.map((hx) => (
            <div key={hx} style={{ position: "absolute", left: (hx - 3) * SCALE, top: (GROUND - 29) * SCALE, width: 50 * SCALE, height: 30 * SCALE, boxShadow: `0 0 40px 12px rgba(250,174,64,${0.5 * glow})`, background: `rgba(250,174,64,${0.12 * glow})` }} />
          ))}
          <div style={{ position: "absolute", left: 48, top: 40, font: `22px/1 ${PIXEL}`, color: C.orange, opacity: clamp((t - T.airportVo) / 0.4) }}>BUILT ON CLOUDFLARE</div>
          {t >= from && <Card {...CARDS[card]!} opacity={clamp((t - from) / 0.4)} />}
        </>
      )}
      {closing && <Close t={t} />}
    </Stage>
  );
}

const CARDS = [
  { title: "ARTIFACTS", color: C.amber, what: "A Git fork for every agent.", why: "Agents work in parallel without touching each other's code, and every push is an event ATC can react to." },
  { title: "DURABLE OBJECTS", color: C.cyan, what: "One per repo, fed by those push events.", why: "Every open pull request and the landing order live in one place, so every agent gets the same answer." },
  { title: "SANDBOX", color: C.green, what: "Containers for the test merges and builds.", why: "Agents' code is built in isolation, never inside ATC itself." },
];

function Card({ title, color, what, why, opacity }: { title: string; color: string; what: string; why: string; opacity: number }) {
  return (
    <div style={{ position: "absolute", left: 960, top: 150, transform: "translateX(-50%)", width: 1100, opacity, padding: "28px 36px 24px", background: "rgba(15,21,48,0.94)", border: `6px solid ${color}`, boxShadow: "8px 8px 0 #0f1530" }}>
      <div style={{ font: `34px/1.2 ${PIXEL}`, color }}>{title}</div>
      <div style={{ font: `44px/1.2 ${TERM}`, color: C.text, marginTop: 16 }}>{what}</div>
      <div style={{ font: `40px/1.2 ${TERM}`, color: C.dim, marginTop: 8 }}>{why}</div>
    </div>
  );
}

function Close({ t }: { t: number }) {
  const k = clamp((t - T.closeStart) / 0.6);
  return (
    <AbsoluteFill style={{ background: `rgba(15,21,48,${0.78 * k})`, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 34, opacity: k }}>
      <div style={{ font: `150px/1 ${PIXEL}`, color: C.orange, textShadow: "10px 10px 0 #000" }}>ATC</div>
      <div style={{ font: `34px/1.3 ${PIXEL}`, color: C.amber }}>AIR TRAFFIC CONTROL FOR AI CODING AGENTS</div>
      <div style={{ font: `40px/1.2 ${TERM}`, color: C.text, marginTop: 20 }}>Built on Cloudflare: Workers · Artifacts · Durable Objects · Workflows · Sandbox · MCP</div>
      <div style={{ font: `30px/1.2 ${TERM}`, color: C.dim }}>The run in this video: {RUN.baseline}, recorded {RUN.recordedAt.slice(0, 10)}</div>
    </AbsoluteFill>
  );
}

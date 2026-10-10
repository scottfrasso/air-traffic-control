/** Beat 5: the wide shot. More traffic lands in sequence while captions name the Cloudflare pieces; then the close. */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import { CHECK, clamp, glide, HANGARS, LIVERY, smooth, TOWER, type Plane } from "../scene/geometry";
import { At, C, Callout, PIXEL, Stage, Tag, TERM } from "../scene/Stage";
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
  const at = (k: number) => T.airportVo + k;
  const show = (k: number) => clamp((t - at(k)) / 0.35);
  const pushPulse = traffic.filter((x) => x.l.phase === "approach").map((x, i) => {
    const phase = (t * 0.7 + i * 0.27) % 1;
    return { from: [x.plane.x, x.plane.y] as [number, number], to: [TOWER.x, TOWER.top - 4] as [number, number], color: C.cyan, progress: phase };
  });
  const scene: Scene = {
    t,
    planes: [...parked, ...traffic.map((x) => x.plane)],
    beams: t > at(2.8) ? pushPulse : [],
    towerLight: t > at(2.8) && Math.floor(t * 3) % 2 === 0 ? C.cyan : undefined,
    checkLight: t > at(6.6) ? (Math.floor(t * 3) % 2 ? C.green : "#2f8a45") : undefined,
  };
  const closing = t >= T.closeStart;
  return (
    <Stage scene={scene}>
      {!closing && (
        <>
          {HANGARS.map((hx, i) => (
            <At key={hx} x={hx + 22} y={226 - 18} anchor="center">
              <div style={{ font: `20px/1 ${PIXEL}`, color: "#fff", textShadow: "3px 3px 0 #0f1530", opacity: show(0.6 + i * 0.25) }}>{["PR6", "PR7", "PR8"][i]}</div>
            </At>
          ))}
          <Callout x={HANGARS[1]! + 22} y={200} rise={34} title="ARTIFACTS" sub="a Git fork per agent" opacity={show(0.2)} />
          <Callout x={TOWER.x - 8} y={TOWER.top - 8} rise={64} title="DURABLE OBJECT" sub="push events · open forks · sequence" opacity={show(2.8)} color={C.cyan} />
          <Callout x={CHECK.x + 30} y={CHECK.y - 12} rise={110} title="SANDBOX" sub="test merges + builds" opacity={show(6.6)} color={C.green} />
        </>
      )}
      {closing && <Close t={t} />}
    </Stage>
  );
}

function Close({ t }: { t: number }) {
  const k = clamp((t - T.closeStart) / 0.6);
  return (
    <AbsoluteFill style={{ background: `rgba(15,21,48,${0.78 * k})`, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 34, opacity: k }}>
      <div style={{ font: `150px/1 ${PIXEL}`, color: C.orange, textShadow: "10px 10px 0 #000" }}>ATC</div>
      <div style={{ font: `34px/1.3 ${PIXEL}`, color: C.amber }}>AIR TRAFFIC CONTROL FOR CODING AGENTS</div>
      <div style={{ font: `40px/1.2 ${TERM}`, color: C.text, marginTop: 20 }}>Built on Cloudflare: Workers · Artifacts · Durable Objects · Workflows · Sandbox · MCP</div>
      <div style={{ font: `30px/1.2 ${TERM}`, color: C.dim }}>The run in this video: {RUN.baseline}, recorded {RUN.recordedAt.slice(0, 10)}</div>
    </AbsoluteFill>
  );
}

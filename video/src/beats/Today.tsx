/** Beats 1–3: two planes, one runway; today's go-around; then the rewind. Illustration, not a recording. */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import { clamp, GATES, glide, landing, LIVERY, path, smooth, TOWER, type Plane, type Pt } from "../scene/geometry";
import { At, C, Caption, PIXEL, Popup, Stage, Tag } from "../scene/Stage";
import { T } from "../timeline";

const touchA = T.todayStart + 2.4;
const wave = T.todayStart + 5.8; // B reaches the threshold and is waved off
const tB0 = -0.2;

/** Where both planes are at story time t (0 … T.todayEnd). */
function story(t: number) {
  const a = landing(t, { t0: 0, s0: -0.05, tTouch: touchA, gate: GATES[0]! });
  let b: { p: Pt; face: 1 | -1 };
  if (t < wave) {
    b = { p: glide(tB0 + ((0.95 - tB0) * t) / wave), face: 1 };
  } else {
    const [x0, y0] = glide(0.95);
    const g = T.todayEnd - wave;
    const { p, v } = path([[wave, x0, y0], [wave + g * 0.15, x0 + 30, y0 - 22], [wave + g * 0.3, 440, 150], [wave + g * 0.45, 420, 104], [wave + g * 0.7, 250, 64], [wave + g, -40, 54]], t);
    b = { p, face: v[0] < 0 ? -1 : 1 };
  }
  return { a, b };
}

function planes(t: number): Plane[] {
  const { a, b } = story(t);
  return [
    { id: "a", x: a.p[0], y: a.p[1], face: a.face, livery: LIVERY.a },
    { id: "b", x: b.p[0], y: b.p[1], face: b.face, livery: LIVERY.b },
  ];
}

const fade = (t: number, at: number, len = 0.4) => clamp((t - at) / len);

export function Today({ t }: { t: number }) {
  const rewinding = t >= T.todayEnd;
  const k = rewinding ? smooth(clamp((t - T.todayEnd) / (T.rewindEnd - T.todayEnd - 0.3))) : 0;
  const st = rewinding ? T.todayEnd * (1 - k) : t; // story time runs backwards during the rewind
  const [pa, pb] = planes(st) as [Plane, Plane];
  const waved = !rewinding && t >= wave;
  const red = waved && t < wave + 2.5 && Math.floor(t * 4) % 2 === 0;
  const scene: Scene = {
    t,
    planes: [pa, pb],
    towerLight: red ? C.red : undefined,
    beams: waved && t < wave + 1.6 ? [{ from: [TOWER.x, TOWER.top - 4], to: [pb.x, pb.y], color: C.red }] : [],
  };
  const ciOn = t > T.setupVo + 8.6;
  const labelA = t < touchA + 1.0 && !rewinding;
  const labelB = !rewinding && t < T.todayEnd - 1.2;
  return (
    <Stage scene={scene} style={rewinding ? { filter: `saturate(${1 - 0.6 * Math.sin(Math.PI * k)}) contrast(1.1)` } : undefined}>
      {labelA && (
        <At x={pa.x} y={pa.y - 8} align="edge">
          <Tag text="A: adds a parameter to createBooking" light={ciOn ? { color: C.green, text: "CI" } : undefined} opacity={fade(t, T.setupVo + 2.3)} />
        </At>
      )}
      {labelB && (
        <At x={pb.x} y={pb.y - 8} align="edge">
          <Tag text={waved ? "B: GO AROUND" : "B: calls createBooking the old way"} bg={waved ? "#8a1f1f" : undefined} light={ciOn ? { color: C.green, text: "CI" } : undefined} opacity={fade(t, T.setupVo + 5.2)} />
        </At>
      )}
      {!rewinding && (
        <>
          <At x={pa.x} y={pa.y}><Popup text="LANDED" color={C.green} age={(t - touchA) / 2.2} /></At>
          <At x={pb.x} y={pb.y}><Popup text="TYPECHECK FAILED" color={C.red} age={(t - wave) / 2.4} /></At>
        </>
      )}
      {t > T.setupVo + 10.6 && t < T.todayStart + 0.2 && <Caption opacity={fade(t, T.setupVo + 10.6)}>git merge A B: <span style={{ color: C.green }}>no conflict</span></Caption>}
      {t > T.todayStart + 0.4 && t < wave + 0.6 && <Caption opacity={fade(t, T.todayStart + 0.4)}><span style={{ color: C.amber }}>TODAY:</span> first tested together at landing</Caption>}
      {waved && t < T.todayEnd && <Caption opacity={fade(t, wave + 0.8)}>B's agent finished. Its session is gone.</Caption>}
      {rewinding && <Rewind k={k} t={t} />}
    </Stage>
  );
}

function Rewind({ k, t }: { k: number; t: number }) {
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 4px, transparent 4px 8px)", transform: `translateY(${(t * 120) % 8}px)` }} />
      <AbsoluteFill style={{ background: "rgba(15,21,48,0.18)" }} />
      <div style={{ position: "absolute", left: 64, top: 56, font: `56px/1 ${PIXEL}`, color: C.text, textShadow: "4px 4px 0 #0f1530", opacity: k < 1 ? (Math.floor(t * 3) % 2 ? 1 : 0.4) : 1 }}>◀◀ REWIND</div>
      <Caption>Test the merge on every push, not at landing.</Caption>
    </AbsoluteFill>
  );
}

/**
 * Beats 1–3: two planes, one runway; today's go-around (rebase onto main, fix, rerun CI, then land);
 * then the rewind. Illustration, not a recording.
 */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import { clamp, GATES, glide, landing, LIVERY, path, smooth, TOWER, type Plane, type Pt } from "../scene/geometry";
import { At, C, Caption, PIXEL, Popup, Stage, Tag } from "../scene/Stage";
import { T, voSeconds } from "../timeline";

const D = T.todayEnd - T.todayStart;
const at = (k: number) => T.todayStart + k * D; // a moment in the "today" beat, as a fraction of it
const touchA = at(0.12);
const wave = at(0.3); // B reaches the threshold and is sent around
const holdStart = at(0.4);
const holdEnd = at(0.78);
const finalStart = holdEnd + 1.0;
const touchB = finalStart + 2.2;
const HOLD = { x: 230, y: 62, rx: 54, ry: 12, w: 1.25 };
const STEPS = ["REBASE ONTO MAIN", "FIX THE CALL", "WAIT FOR CI AGAIN"];

function holding(t: number): { p: Pt; face: 1 | -1 } {
  const th = (t - holdStart) * HOLD.w;
  return { p: [HOLD.x + HOLD.rx * Math.cos(th), HOLD.y + HOLD.ry * Math.sin(th)], face: Math.sin(th) > 0 ? -1 : 1 };
}

/** Where both planes are at time t (absolute video seconds). */
function story(t: number) {
  const a = landing(t, { t0: T.setupStart, s0: -0.05, tTouch: touchA, gate: GATES[0]! });
  let b: { p: Pt; face: 1 | -1 };
  if (t < wave) {
    b = { p: glide(-0.2 + (1.15 * (t - T.setupStart)) / (wave - T.setupStart)), face: 1 };
  } else if (t < holdStart) {
    const [x0, y0] = glide(0.95);
    const h = holding(holdStart).p;
    const g = holdStart - wave;
    const { p, v } = path([[wave, x0, y0], [wave + g * 0.3, x0 + 26, y0 - 30], [wave + g * 0.65, 420, 90], [holdStart, h[0], h[1]]], t);
    b = { p, face: v[0] < 0 ? -1 : 1 };
  } else if (t < holdEnd) {
    b = holding(t);
  } else if (t < finalStart) {
    const h = holding(holdEnd).p, f = glide(0.55);
    const { p, v } = path([[holdEnd, h[0], h[1]], [holdEnd + 0.5, (h[0] + f[0]) / 2, (h[1] + f[1]) / 2 + 6], [finalStart, f[0], f[1]]], t);
    b = { p, face: v[0] < 0 ? -1 : 1 };
  } else {
    const l = landing(t, { t0: finalStart, s0: 0.55, tTouch: touchB, gate: GATES[1]! });
    b = { p: l.p, face: l.face };
  }
  return { a, b };
}

function planes(t: number): [Plane, Plane] {
  const { a, b } = story(t);
  return [
    { id: "a", x: a.p[0], y: a.p[1], face: a.face, livery: LIVERY.a },
    { id: "b", x: b.p[0], y: b.p[1], face: b.face, livery: LIVERY.b },
  ];
}

const fade = (t: number, from: number, len = 0.4) => clamp((t - from) / len);

export function Today({ t }: { t: number }) {
  const rewinding = t >= T.todayEnd;
  const k = rewinding ? smooth(clamp((t - T.todayEnd) / (T.rewindEnd - T.todayEnd - 0.3))) : 0;
  const st = rewinding ? T.todayEnd - (T.todayEnd - T.setupStart) * k : t; // story time runs backwards during the rewind
  const [pa, pb] = planes(st);
  const sentAround = !rewinding && t >= wave && t < touchB;
  const red = sentAround && t < wave + 2.5 && Math.floor(t * 4) % 2 === 0;
  const scene: Scene = {
    t,
    planes: [pa, pb],
    towerLight: red ? C.red : undefined,
    beams: sentAround && t < wave + 1.6 ? [{ from: [TOWER.x, TOWER.top - 4], to: [pb.x, pb.y], color: C.red }] : [],
  };
  const ci = t > T.setupVo + 0.62 * voSeconds("setup") ? { color: C.green, text: "CI" } : undefined;
  const step = t >= holdStart && t < holdEnd ? STEPS[Math.min(2, Math.floor(((t - holdStart) / (holdEnd - holdStart)) * 3))] : null;
  const labelA = !rewinding && t < touchA + 1.0;
  const labelB = !rewinding && t > T.setupStart && t < touchB;
  const bText = step ? `B: ${step}` : t >= wave && t < holdStart ? "B: GO AROUND" : t >= holdEnd ? "B: rebased, landing" : "B: calls that function the old way";
  return (
    <Stage scene={scene} style={rewinding ? { filter: `saturate(${1 - 0.6 * Math.sin(Math.PI * k)}) contrast(1.1)` } : undefined}>
      {labelA && (
        <At x={pa.x} y={pa.y - 8} align="edge">
          <Tag text="A: changes a function's parameters" light={ci} opacity={fade(t, T.setupVo + 0.24 * voSeconds("setup"))} />
        </At>
      )}
      {labelB && (
        <At x={pb.x} y={pb.y - 8} align="edge">
          <Tag text={bText} bg={t >= wave && t < holdEnd ? "#8a1f1f" : undefined} light={ci} opacity={fade(t, T.setupVo + 0.42 * voSeconds("setup"))} />
        </At>
      )}
      {!rewinding && (
        <>
          <At x={pa.x} y={pa.y}><Popup text="MERGED" color={C.green} age={(t - touchA) / 2.2} /></At>
          <At x={pb.x} y={pb.y}><Popup text="BUILD BROKEN" color={C.red} age={(t - wave) / 2.4} /></At>
          <At x={pb.x} y={pb.y}><Popup text="LANDED, LATE" color={C.amber} age={(t - touchB) / 2.2} /></At>
        </>
      )}
      {t > T.setupVo + 0.8 * voSeconds("setup") && t < T.todayStart + 0.4 && <Caption opacity={fade(t, T.setupVo + 0.8 * voSeconds("setup"))}>Git: no merge conflict</Caption>}
      {t > T.todayStart + 0.4 && t < holdStart && <Caption opacity={fade(t, T.todayStart + 0.4)}><span style={{ color: C.amber }}>TODAY:</span> the two changes meet at merge time</Caption>}
      {t >= holdStart && t < at(0.63) && <Caption opacity={fade(t, holdStart)}>Go-around: rebase onto main, fix, rerun CI</Caption>}
      {t >= at(0.63) && t < T.todayEnd && <Caption opacity={fade(t, at(0.63))}>B's agent has finished, so a person does it</Caption>}
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
      <Caption>ATC checks the merge on every push instead</Caption>
    </AbsoluteFill>
  );
}

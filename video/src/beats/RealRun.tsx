/**
 * Beat 4: the recorded run. Event order, PR numbers, the typecheck error, clearances and the clock all come
 * from src/data/run.json. Plane distances are staged from the same clock, B's flag fires while it's far out.
 */
import type { Scene } from "../scene/draw";
import { CHECK, clamp, GATES, GROUND, landing, LIVERY, RUNWAY, SCALE, type Plane } from "../scene/geometry";
import { At, C, Caption, PIXEL, Popup, Stage, Tag, TERM } from "../scene/Stage";
import { ERROR, REAL, RUN, T, videoToReal } from "../timeline";

const WORD: Record<string, string> = { cleared: "CLEARED", follow: "FOLLOW", hold: "HOLD", go_around: "GO AROUND", checking: "STANDBY" };
const CLR: Record<string, string> = { cleared: C.green, follow: C.text, hold: C.amber, go_around: C.red, checking: C.cyan };

/** A and B in the recorded run (also used by beat 5, so they keep taxiing across the cut). */
export const runA = (t: number) => landing(t, { t0: T.b4, s0: 0.24, tTouch: T.landA, gate: GATES[0]! });
export const runB = (t: number) => landing(t, { t0: T.b4, s0: -0.02, tTouch: T.landB, gate: GATES[1]! });

export function RealRun({ t }: { t: number }) {
  const r = videoToReal(t);
  const a = runA(t);
  const b = runB(t);
  const pa: Plane = { id: "a", x: a.p[0], y: a.p[1], face: a.face, livery: LIVERY.a };
  const pb: Plane = { id: "b", x: b.p[0], y: b.p[1], face: b.face, livery: LIVERY.b };

  const flagged = t >= T.flag && t < T.fix;
  const checking = (r > 0.8 && t < T.flag) || (t >= T.fix + 0.4 && t < T.clean);
  const green = t >= T.clean && t < T.landB + 0.6;
  const pulse = (at: number, len = 0.9) => clamp((t - at) / len);
  const beams: NonNullable<Scene["beams"]> = [];
  for (const [p, at] of [[pa, T.v0], [pb, T.v0], [pb, T.fix]] as const) if (t >= at && t < at + 1.4) beams.push({ from: [p.x, p.y], to: [CHECK.x, CHECK.y - 4], color: C.cyan, progress: pulse(at) });
  const scene: Scene = {
    t,
    planes: [pa, pb],
    conflict: flagged ? ["a", "b"] : undefined,
    blink: flagged ? ["a", "b"] : [],
    beams,
    checkLight: flagged ? C.red : checking ? (Math.floor(t * 4) % 2 ? C.amber : "#8a6a20") : green ? C.green : undefined,
    towerLight: flagged && Math.floor(t * 4) % 2 === 0 ? C.red : undefined,
  };

  const fixed = t >= T.fix;
  const clean = t >= T.clean;
  const bLight = flagged ? { color: C.red, text: "ATC" } : clean ? { color: C.green, text: "ATC" } : undefined;
  const seq = [...RUN.sequences].reverse().find((s) => s.t <= r)?.sequence ?? [];
  return (
    <Stage scene={scene}>
      {a.phase === "approach" && <At x={pa.x} y={pa.y + 10} anchor="top" align="edge"><Tag below text={`${RUN.a} · A: changes a function's parameters`} light={clean ? { color: C.green, text: "ATC" } : flagged ? { color: C.red, text: "ATC" } : undefined} /></At>}
      {b.phase === "approach" && <At x={pb.x} y={pb.y - 8} align="edge"><Tag text={fixed ? `${RUN.b} · B: merged ${RUN.a}, fixed its call` : `${RUN.b} · B: calls that function the old way`} bg={flagged ? "#8a1f1f" : undefined} light={bLight} /></At>}

      <At x={pa.x} y={pa.y}><Popup text={t < T.flag ? "PUSH" : t < T.landA ? "CONFLICT!" : "LANDED"} color={t < T.flag ? "#fff" : t < T.landA ? C.red : C.green} age={t < T.flag ? (t - T.v0) / 2 : t < T.landA ? (t - T.flag) / 2.4 : (t - T.landA) / 2.2} /></At>
      <At x={pb.x} y={pb.y}><Popup text={t < T.flag ? "PUSH" : t < T.fix ? "CONFLICT!" : t < T.landB ? "PUSH FIX" : "LANDED"} color={t < T.flag ? "#fff" : t < T.fix ? C.red : t < T.landB ? C.cyan : C.green} age={t < T.flag ? (t - T.v0) / 2 : t < T.fix ? (t - T.flag) / 2.4 : t < T.landB ? (t - T.fix) / 2 : (t - T.landB) / 2.2} /></At>

      {flagged && <ErrorBox t={t} />}
      {flagged && <FarOut x={pb.x} opacity={clamp((t - T.flag - 0.8) / 0.4)} />}
      {fixed && seq.length > 0 && <Board seq={seq} />}
      {t < T.flag && <Caption opacity={clamp((t - T.b4 - 0.4) / 0.4)}>Every push is merged with the other open PRs and type checked</Caption>}
      <Clock r={r} />
    </Stage>
  );
}

function Clock({ r }: { r: number }) {
  const s = Math.max(0, r);
  return (
    <div style={{ position: "absolute", left: 48, top: 40, padding: "14px 20px 10px", background: "rgba(15,21,48,0.92)", border: `4px solid ${C.edge}` }}>
      <div style={{ font: `20px/1 ${PIXEL}`, color: C.red }}>● REAL RUN</div>
      <div style={{ font: `30px/1.1 ${TERM}`, color: C.dim, marginTop: 8 }}>{RUN.baseline} · Cloudflare</div>
      <div style={{ font: `30px/1 ${PIXEL}`, color: C.text, marginTop: 10 }}>T+{s.toFixed(1).padStart(4, "0")}s</div>
    </div>
  );
}

function ErrorBox({ t }: { t: number }) {
  const k = clamp((t - T.flag) / 0.25);
  const [where, code, ...msg] = ERROR.split(" ");
  return (
    <div style={{ position: "absolute", left: 1090, top: 120, transform: `translateX(-50%) scale(${0.9 + 0.1 * k})`, opacity: k, width: 1120, padding: "22px 30px 18px", background: "rgba(15,21,48,0.96)", border: `6px solid ${C.red}`, boxShadow: "8px 8px 0 #0f1530" }}>
      <div style={{ font: `22px/1.4 ${PIXEL}`, color: C.red }}>{RUN.a} + {RUN.b} FAIL TOGETHER · {REAL.conflict.toFixed(1)}s AFTER PUSH</div>
      <div style={{ font: `36px/1.2 ${TERM}`, color: C.dim, marginTop: 10 }}>tsc on the merged code</div>
      <div style={{ font: `42px/1.15 ${TERM}`, color: C.text, marginTop: 6 }}>
        <span style={{ color: C.amber }}>{where}</span> {code} {msg.join(" ")}
      </div>
      <div style={{ font: `34px/1.2 ${TERM}`, color: C.dim, marginTop: 6 }}>Each pull request passes on its own. Both agents get this signal.</div>
    </div>
  );
}

/** Exaggerated distance marker: B is nowhere near the runway when it's flagged. */
function FarOut({ x, opacity }: { x: number; opacity: number }) {
  const y = GROUND + 14;
  const left = x * SCALE, right = RUNWAY.x * SCALE;
  return (
    <div style={{ position: "absolute", left, top: y * SCALE, width: right - left, opacity }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 18, height: 8, background: C.orange }} />
      <div style={{ position: "absolute", left: -4, top: 0, width: 8, height: 44, background: C.orange }} />
      <div style={{ position: "absolute", right: -4, top: 0, width: 8, height: 44, background: C.orange }} />
      <div style={{ position: "absolute", left: "50%", top: 40, transform: "translateX(-50%)", padding: "10px 18px 6px", background: "rgba(15,21,48,0.92)", color: C.orange, font: `24px/1 ${PIXEL}`, whiteSpace: "nowrap" }}>B IS STILL A LONG WAY FROM LANDING</div>
    </div>
  );
}

function Board({ seq }: { seq: Array<{ pr: string; clearance: string; reason: string }> }) {
  return (
    <div style={{ position: "absolute", left: 48, top: 210, width: 720, padding: "16px 22px 12px", background: "rgba(22,31,66,0.95)", border: `4px solid ${C.edge}` }}>
      <div style={{ font: `18px/1 ${PIXEL}`, color: C.cyan, marginBottom: 12 }}>LANDING SEQUENCE</div>
      {seq.map((e, i) => (
        <div key={e.pr} style={{ display: "grid", gridTemplateColumns: "50px 90px 1fr", alignItems: "baseline", padding: "6px 0" }}>
          <span style={{ font: `30px/1 ${TERM}`, color: C.dim }}>#{i + 1}</span>
          <span style={{ font: `18px/1 ${PIXEL}`, color: C.text }}>{e.pr}</span>
          <span style={{ font: `30px/1 ${TERM}`, color: C.dim }}>
            <span style={{ font: `18px/1 ${PIXEL}`, color: CLR[e.clearance] ?? C.text, marginRight: 12 }}>{WORD[e.clearance] ?? e.clearance.toUpperCase()}</span>
            {e.reason}
          </span>
        </div>
      ))}
    </div>
  );
}

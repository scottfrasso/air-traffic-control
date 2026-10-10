/**
 * Beat 4: the recorded five-PR run. Pair checks, the conflict, the tsc error, the landing order and its reasons,
 * diff sizes, landings and the clock all come from src/data/run.json. Plane positions are staged from that data:
 * each plane sits in the approach slot of its place in ATC's sequence.
 */
import type { ReactNode } from "react";
import type { Scene } from "../scene/draw";
import { CHECK, clamp, GATES, glide, GROUND, landing, lerp, LIVERY, RUNWAY, SCALE, smooth, type Plane, type Pt } from "../scene/geometry";
import { At, C, Caption, PIXEL, Popup, Stage, Tag, TERM } from "../scene/Stage";
import { ERROR, LANDS, PAIRS, REAL, RUN, SEQ1, SEQ2, T, realToVideo, videoToReal, voSeconds } from "../timeline";

const WORD: Record<string, string> = { cleared: "CLEARED", follow: "FOLLOW", hold: "HOLD", go_around: "GO AROUND", checking: "STANDBY", fix: "HOLD" };
const CLR: Record<string, string> = { cleared: C.green, follow: C.text, hold: C.amber, go_around: C.red, checking: C.cyan, fix: C.amber };
export const PRS = ["PR1", "PR2", "PR3", "PR4", "PR5"];
export const LIV: Record<string, string> = { PR1: LIVERY.a, PR2: LIVERY.b, PR3: LIVERY.c, PR4: LIVERY.d, PR5: LIVERY.e };
const SHORT: Record<string, string> = {
  [RUN.a]: "changes a function",
  [RUN.b]: "calls it the old way",
};
const DIFF: Record<string, number> = Object.fromEntries(RUN.forks.map((f) => [f.pr, f.diff]));
const SLOTS = [0.92, 0.765, 0.61, 0.455, 0.3];

const order = (seq: Array<{ pr: string }>) => seq.map((x) => x.pr);
const at = (k: number) => T.orderVo + k * voSeconds("order"); // a moment in the "order" line
const SWAP = at(0.36); // planes re-sequence into ATC's order as the line reaches "ATC picks the order"
const LAND_V = new Map(LANDS.map((l) => [l.pr, realToVideo(l.t)]));
const FINAL = 1.8; // seconds from the first slot to touchdown

/** Sequence changes over video time: arrival order, ATC's first order, the order after PR1's fix, then landings. */
const CHANGES: Array<{ t: number; order: string[] }> = (() => {
  const out = [
    { t: -Infinity, order: PRS },
    { t: SWAP, order: order(SEQ1.sequence) },
    { t: Math.max(SWAP + 2, realToVideo(REAL.resequenced)), order: order(SEQ2.sequence) },
  ];
  for (const l of LANDS) {
    const t = (LAND_V.get(l.pr) ?? 0) - FINAL;
    out.push({ t, order: out[out.length - 1]!.order.filter((p) => p !== l.pr) });
  }
  return out.sort((a, b) => a.t - b.t);
})();

/** Where a PR's plane is at video time t (also used by beat 5, so parked planes carry over). */
export function where(pr: string, t: number): { p: Pt; face: 1 | -1; flying: boolean; slot: number } {
  const tl = LAND_V.get(pr) ?? Infinity;
  if (t >= tl - FINAL) {
    const l = landing(t, { t0: tl - FINAL, s0: SLOTS[0]!, tTouch: tl, gate: GATES[LANDS.findIndex((x) => x.pr === pr)]! });
    return { p: l.p, face: l.face, flying: l.phase === "approach", slot: 0 };
  }
  let k = 0;
  while (k + 1 < CHANGES.length && CHANGES[k + 1]!.t <= t) k++;
  const now = CHANGES[k]!, prev = CHANGES[Math.max(0, k - 1)]!;
  const sNew = SLOTS[now.order.indexOf(pr)] ?? SLOTS[4]!;
  const sOld = SLOTS[prev.order.indexOf(pr)] ?? sNew;
  const u = smooth(clamp((t - now.t) / 1.6));
  let s = lerp(sOld, sNew, u);
  s -= 0.35 * (1 - smooth(clamp((t - T.b4) / 3))); // fly in from the left at the start of the beat
  const [x, y] = glide(s);
  const lift = sNew < sOld ? -16 : 8; // planes dropping back climb over the ones moving up
  return { p: [x, y + (sNew === sOld ? 0 : lift * Math.sin(Math.PI * u))], face: 1, flying: true, slot: now.order.indexOf(pr) };
}

export function RealRun({ t }: { t: number }) {
  const r = videoToReal(t);
  const ps = PRS.map((pr) => ({ pr, ...where(pr, t) }));
  const planes: Plane[] = ps.map((x) => ({ id: x.pr, x: x.p[0], y: x.p[1], face: x.face, livery: LIV[x.pr]! }));
  const byPr = new Map(ps.map((x) => [x.pr, x]));
  const flagged = t >= T.flag && t < T.fix;
  const pairsDone = PAIRS.filter((p) => realToVideo(p.t) <= t).length;
  const checking = (t > T.v0 + 0.6 && pairsDone < PAIRS.length) || (t >= T.fix + 0.3 && t < realToVideo(REAL.resequenced));
  const pushes = RUN.events.filter((e) => e.kind === "push.received" && e.pr).map((e) => ({ pr: e.pr!, v: realToVideo(e.t) }));
  const beams: NonNullable<Scene["beams"]> = [];
  for (const p of pushes) {
    const pl = byPr.get(p.pr);
    if (pl && t >= p.v && t < p.v + 1.3) beams.push({ from: pl.p, to: [CHECK.x, CHECK.y - 4], color: C.cyan, progress: clamp((t - p.v) / 0.9) });
  }
  // Each pair check, drawn as a line between the two planes when it finishes (green), the failing one stays red.
  for (const pc of PAIRS) {
    const v = realToVideo(pc.t), pa = byPr.get(pc.a), pb = byPr.get(pc.b);
    if (pa && pb && pc.status !== "semantic_conflict" && t >= v && t < v + 1.4) beams.push({ from: pa.p, to: pb.p, color: C.green });
  }
  const scene: Scene = {
    t,
    planes,
    conflict: flagged ? [RUN.a, RUN.b] : undefined,
    blink: flagged ? [RUN.a, RUN.b] : [],
    beams,
    checkLight: flagged && t < T.flag + 2.5 ? C.red : checking ? (Math.floor(t * 4) % 2 ? C.amber : "#8a6a20") : t > T.v0 + 1 ? C.green : undefined,
    towerLight: t >= SWAP && t < SWAP + 2 && Math.floor(t * 4) % 2 === 0 ? C.cyan : undefined,
  };
  const shown = t >= SWAP;
  const seq = shown ? ([...RUN.sequences].reverse().find((s) => s.t <= Math.max(r, REAL.settled))?.sequence ?? []) : [];
  const clr = new Map(seq.map((x) => [x.pr, x.clearance]));
  const caption =
    t < T.flag ? "ATC analyzes each push against every other open PR"
    : t < T.orderVo ? null
    : t < SWAP ? "A merge train lands them in the order they arrived"
    : t < T.holdVo + 0.5 ? "ATC: smaller changes first. The bigger of the two waits."
    : t >= T.lastLand - 0.5 ? "All five landed in order. Nobody rebased." : null;
  const captionFrom = t < T.flag ? T.b4 + 0.4 : t < SWAP ? T.orderVo : t < T.holdVo + 0.5 ? SWAP : T.lastLand - 0.5;
  return (
    <Stage scene={scene}>
      {ps.map((x) => {
        if (!x.flying || !SHORT[x.pr] || t >= (LAND_V.get(x.pr) ?? Infinity) - FINAL || t < T.flag) return null;
        const c = clr.get(x.pr);
        const red = flagged;
        const below = x.pr === RUN.b;
        const text = x.pr === RUN.a && t >= T.fix ? "fixed the call" : SHORT[x.pr]!;
        const light = x.pr === RUN.a && c === "hold" ? { color: C.amber, text: "WAITS" } : undefined;
        return (
          <At key={x.pr} x={x.p[0]} y={below ? x.p[1] + 9 : x.p[1] - 8} anchor={below ? "top" : "bottom"} align="edge">
            <Tag text={text} below={below} bg={red ? "#8a1f1f" : undefined} light={light} />
          </At>
        );
      })}
      {ps.map((x) => {
        const land = LAND_V.get(x.pr);
        const pop = flagged && (x.pr === RUN.a || x.pr === RUN.b) ? { text: "CONFLICT", color: C.red, age: (t - T.flag) / 2.4 }
          : land !== undefined && t >= land ? { text: "LANDED", color: C.green, age: (t - land) / 2.2 } : null;
        return pop ? <At key={x.pr} x={x.p[0]} y={x.p[1]}><Popup {...pop} /></At> : null;
      })}
      <Clock r={r} />
      {t >= T.flag && t < T.orderVo && (
        <Panel x={560} y={60} w={800} border={C.red}>
          <div style={{ font: `20px/1.4 ${PIXEL}`, color: C.red }}>BREAKS ONLY WHEN COMBINED</div>
          <div style={{ font: `36px/1.2 ${TERM}`, color: C.text, marginTop: 6 }}>{ERROR.replace(/^(\S+) (TS\d+) /, "$1  ")}</div>
        </Panel>
      )}
      {caption && <Caption opacity={clamp((t - captionFrom) / 0.4)}>{caption}</Caption>}
    </Stage>
  );
}

function Panel({ x, y, w, children, border = C.edge }: { x: number; y: number; w: number; children: ReactNode; border?: string }) {
  return <div style={{ position: "absolute", left: x, top: y, width: w, padding: "16px 22px 14px", background: "rgba(15,21,48,0.94)", border: `4px solid ${border}` }}>{children}</div>;
}

function Clock({ r }: { r: number }) {
  return (
    <Panel x={48} y={28} w={520}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
        <span style={{ font: `20px/1 ${PIXEL}`, color: C.red, whiteSpace: "nowrap" }}>● RECORDED RUN</span>
        <span style={{ font: `26px/1 ${PIXEL}`, color: C.text, marginLeft: "auto" }}>{Math.max(0, r).toFixed(1)}s</span>
      </div>
    </Panel>
  );
}





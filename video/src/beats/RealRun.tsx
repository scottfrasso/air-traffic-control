/**
 * Beat 4: the recorded five-PR run. Pair checks, the conflict, the tsc error, the landing order and its reasons,
 * diff sizes, landings and the clock all come from src/data/run.json. Plane positions are staged from that data:
 * each plane sits in the approach slot of its place in ATC's sequence.
 */
import type { ReactNode } from "react";
import type { Scene } from "../scene/draw";
import { CHECK, clamp, GATES, glide, GROUND, landing, lerp, LIVERY, RUNWAY, SCALE, smooth, type Plane, type Pt } from "../scene/geometry";
import { At, C, PIXEL, Popup, Stage, Tag, TERM } from "../scene/Stage";
import { ERROR, LANDS, PAIRS, REAL, RUN, SEQ1, SEQ2, T, realToVideo, videoToReal, voSeconds } from "../timeline";

const WORD: Record<string, string> = { cleared: "CLEARED", follow: "FOLLOW", hold: "HOLD", go_around: "GO AROUND", checking: "STANDBY", fix: "HOLD" };
const CLR: Record<string, string> = { cleared: C.green, follow: C.text, hold: C.amber, go_around: C.red, checking: C.cyan, fix: C.amber };
export const PRS = ["PR1", "PR2", "PR3", "PR4", "PR5"];
export const LIV: Record<string, string> = { PR1: LIVERY.a, PR2: LIVERY.b, PR3: LIVERY.c, PR4: LIVERY.d, PR5: LIVERY.e };
const SHORT: Record<string, string> = {
  [RUN.a]: "changes a function",
  [RUN.b]: "calls it the old way",
  ...Object.fromEntries(RUN.traffic.map((x) => [x.pr, x.title.toLowerCase().replace(/^(add|document) /, "")])),
};
const DIFF: Record<string, number> = Object.fromEntries(RUN.forks.map((f) => [f.pr, f.diff]));
const SLOTS = [0.92, 0.765, 0.61, 0.455, 0.3];

const order = (seq: Array<{ pr: string }>) => seq.map((x) => x.pr);
const at = (k: number) => T.orderVo + k * voSeconds("order"); // a moment in the "order" line
const SWAP = at(0.86); // planes re-sequence into ATC's order as the line reaches "the smaller change goes first"
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
  return (
    <Stage scene={scene}>
      {ps.map((x) => {
        if (!x.flying || t >= (LAND_V.get(x.pr) ?? Infinity) - FINAL) return null;
        const c = clr.get(x.pr);
        const red = flagged && (x.pr === RUN.a || x.pr === RUN.b);
        const below = x.slot % 2 === 1;
        const text = x.pr === RUN.a && t >= T.fix ? `${x.pr} · merged ${RUN.b}, fixed the call` : `${x.pr} · ${SHORT[x.pr]}`;
        return (
          <At key={x.pr} x={x.p[0]} y={below ? x.p[1] + 9 : x.p[1] - 8} anchor={below ? "top" : "bottom"} align="edge">
            <Tag text={text} below={below} bg={red ? "#8a1f1f" : undefined} light={c ? { color: CLR[c] ?? C.text, text: WORD[c] ?? c.toUpperCase() } : undefined} />
          </At>
        );
      })}
      {ps.map((x) => {
        const push = pushes.find((p) => p.pr === x.pr && t >= p.v && t < p.v + 2);
        const land = LAND_V.get(x.pr);
        const pop = flagged && (x.pr === RUN.a || x.pr === RUN.b) ? { text: "CONFLICT!", color: C.red, age: (t - T.flag) / 2.4 }
          : land !== undefined && t >= land ? { text: "LANDED", color: C.green, age: (t - land) / 2.2 }
          : push ? { text: x.pr === RUN.a && push.v > T.v0 + 5 ? "PUSH FIX" : "PUSH", color: "#fff", age: (t - push.v) / 2 } : null;
        return pop ? <At key={x.pr} x={x.p[0]} y={x.p[1]}><Popup {...pop} /></At> : null;
      })}

      <Clock r={r} />
      {t < at(0.2) && <PairGrid t={t} />}
      {t >= at(0.2) && t < T.landVo && <Rules t={t} />}
      {shown && t < T.landVo + 1 && <Board seq={seq} />}
      {t >= T.flag && t < T.orderVo && <NotYet x={byPr.get(RUN.b)!.p[0]} opacity={clamp((t - T.flag - 0.8) / 0.4)} />}
      {t >= T.landVo && (
        <Panel x={970} y={28} w={900} border={C.green}>
          <div style={{ font: `22px/1.5 ${PIXEL}`, color: C.green }}>LANDED IN ORDER</div>
          <div style={{ font: `40px/1.2 ${TERM}`, color: C.text, marginTop: 6 }}>{LANDS.filter((l) => t >= (LAND_V.get(l.pr) ?? 0)).map((l) => l.pr).join(" → ") || "…"}</div>
          <div style={{ font: `34px/1.2 ${TERM}`, color: C.dim, marginTop: 8 }}>Told to rebase: <span style={{ color: C.text }}>{RUN.rebased.length ? RUN.rebased.join(", ") : "nobody"}</span></div>
        </Panel>
      )}
    </Stage>
  );
}

function Panel({ x, y, w, children, border = C.edge }: { x: number; y: number; w: number; children: ReactNode; border?: string }) {
  return <div style={{ position: "absolute", left: x, top: y, width: w, padding: "16px 22px 14px", background: "rgba(15,21,48,0.94)", border: `4px solid ${border}` }}>{children}</div>;
}

function Clock({ r }: { r: number }) {
  return (
    <Panel x={48} y={28} w={880}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
        <span style={{ font: `20px/1 ${PIXEL}`, color: C.red }}>● REAL RUN</span>
        <span style={{ font: `30px/1 ${TERM}`, color: C.dim }}>{RUN.baseline} on Cloudflare</span>
        <span style={{ font: `26px/1 ${PIXEL}`, color: C.text, marginLeft: "auto" }}>T+{Math.max(0, r).toFixed(1).padStart(4, "0")}s</span>
      </div>
    </Panel>
  );
}

/** The ten pairs, filling in as the real checks finish. */
function PairGrid({ t }: { t: number }) {
  const done = PAIRS.filter((p) => realToVideo(p.t) <= t);
  const cell = (a: string, b: string) => done.find((p) => p.a === a && p.b === b);
  const bad = done.find((p) => p.status === "semantic_conflict");
  return (
    <Panel x={970} y={28} w={900} border={bad ? C.red : C.edge}>
      <div style={{ font: `20px/1.4 ${PIXEL}`, color: C.cyan }}>EVERY PAIR, MERGED + TYPE CHECKED · {done.length}/{PAIRS.length}</div>
      <div style={{ display: "grid", gridTemplateColumns: "90px repeat(4, 110px)", gap: 6, marginTop: 14, alignItems: "center" }}>
        <span />
        {PRS.slice(1).map((p) => <span key={p} style={{ font: `18px/1 ${PIXEL}`, color: C.dim, textAlign: "center" }}>{p}</span>)}
        {PRS.slice(0, 4).flatMap((a, i) => [
          <span key={a} style={{ font: `18px/1 ${PIXEL}`, color: C.dim }}>{a}</span>,
          ...PRS.slice(1).map((b, j) => {
            if (j < i) return <span key={a + b} />;
            const c = cell(a, b);
            const red = c?.status === "semantic_conflict";
            return <span key={a + b} style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: c ? (red ? "#8a1f1f" : "#1f5a33") : "#232c52", font: `22px/1 ${PIXEL}`, color: c ? (red ? C.red : C.green) : C.dim }}>{c ? (red ? "✗" : "✓") : "·"}</span>;
          }),
        ])}
      </div>
      {bad && (
        <div style={{ marginTop: 14 }}>
          <div style={{ font: `30px/1.15 ${TERM}`, color: C.text }}><span style={{ color: C.red }}>{bad.a} + {bad.b}:</span> <span style={{ color: C.amber }}>{ERROR.split(" ")[0]}</span> {ERROR.split(" ").slice(1).join(" ")}</div>
          <div style={{ font: `30px/1.15 ${TERM}`, color: C.dim }}>Each passes on its own. Both agents get this signal.</div>
        </div>
      )}
    </Panel>
  );
}

/** How ATC picks the order: arrival order vs. ATC's rules, with the real inputs. */
function Rules({ t }: { t: number }) {
  const show = (k: number) => clamp((t - at(k)) / 0.35);
  const atcOrder = order(SEQ1.sequence);
  const line = (k: number, children: ReactNode, color: string = C.text) => <div style={{ font: `30px/1.25 ${TERM}`, color, opacity: show(k) }}>{children}</div>;
  const n = (x: number) => <span style={{ font: `16px/1 ${PIXEL}`, color: C.amber, marginRight: 10 }}>{x}.</span>;
  return (
    <Panel x={970} y={28} w={900} border={C.cyan}>
      <div style={{ font: `20px/1.4 ${PIXEL}`, color: C.cyan }}>HOW ATC PICKS THE LANDING ORDER</div>
      {line(0.08, <>Merge train, arrival order: <span style={{ textDecoration: t >= SWAP ? "line-through" : "none" }}>{PRS.join(" → ")}</span></>, C.dim)}
      {line(0.25, "ATC reads the code: which functions each PR changes, which pairs break.")}
      <div style={{ height: 8 }} />
      {line(0.62, <>{n(1)}Asked to land first? <span style={{ color: C.dim }}>none had yet</span></>)}
      {line(0.72, <>{n(2)}Passes on the current main? <span style={{ color: C.green }}>all five do</span></>)}
      {line(0.82, <>{n(3)}Smaller change first: <span style={{ color: C.amber }}>{atcOrder.map((p) => `${p} ${DIFF[p]}`).join(" · ")}</span> lines</>)}
      {line(0.9, <>{n(4)}Conflicts with a PR ahead of it? <span style={{ color: C.amber }}>{RUN.a} holds behind {RUN.b}</span></>)}
      <div style={{ font: `30px/1.3 ${TERM}`, color: C.text, marginTop: 8, opacity: show(0.95) }}>
        ATC order: <span style={{ color: C.green }}>{atcOrder.join(" → ")}</span>
      </div>
    </Panel>
  );
}

/** Nobody has asked to land when the conflict is found. */
function NotYet({ x, opacity }: { x: number; opacity: number }) {
  const left = x * SCALE, right = RUNWAY.x * SCALE, y = (GROUND + 14) * SCALE;
  return (
    <div style={{ position: "absolute", left, top: y, width: right - left, opacity }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 18, height: 8, background: C.orange }} />
      <div style={{ position: "absolute", left: -4, top: 0, width: 8, height: 44, background: C.orange }} />
      <div style={{ position: "absolute", right: -4, top: 0, width: 8, height: 44, background: C.orange }} />
      <div style={{ position: "absolute", left: "50%", top: 40, transform: "translateX(-50%)", padding: "10px 18px 6px", background: "rgba(15,21,48,0.92)", color: C.orange, font: `22px/1 ${PIXEL}`, whiteSpace: "nowrap" }}>FOUND BEFORE ANY PR ASKED TO LAND</div>
    </div>
  );
}

function Board({ seq }: { seq: Array<{ pr: string; clearance: string; reason: string }> }) {
  return (
    <Panel x={48} y={118} w={880}>
      <div style={{ font: `18px/1 ${PIXEL}`, color: C.cyan, marginBottom: 10 }}>LANDING SEQUENCE, IN ATC'S WORDS</div>
      {seq.map((e, i) => (
        <div key={e.pr} style={{ display: "grid", gridTemplateColumns: "44px 80px 1fr", alignItems: "baseline", padding: "3px 0" }}>
          <span style={{ font: `28px/1 ${TERM}`, color: C.dim }}>#{i + 1}</span>
          <span style={{ font: `16px/1 ${PIXEL}`, color: C.text }}>{e.pr}</span>
          <span style={{ font: `28px/1.05 ${TERM}`, color: C.dim }}>
            <span style={{ font: `16px/1 ${PIXEL}`, color: CLR[e.clearance] ?? C.text, marginRight: 10 }}>{WORD[e.clearance] ?? e.clearance.toUpperCase()}</span>
            {e.reason}
          </span>
        </div>
      ))}
    </Panel>
  );
}

/**
 * Part 2a: the problem, in plain graphics before any airport. Four panels, one per line:
 * branches fan out · merges clean, doesn't build · found too late · the rebase storm; then the two questions.
 * Illustration, not a recording.
 */
import type { ReactNode } from "react";
import { clamp, LIVERY, smooth } from "../scene/geometry";
import { Board, fade, Label, Person, Robot } from "../scene/Overlay";
import { C, PIXEL, TERM } from "../scene/Stage";
import { cue, T } from "../timeline";

const COLORS = Object.values(LIVERY);

export function Problem({ t }: { t: number }) {
  if (t < T.cleanVo - 0.6) return <Fan t={t} />;
  if (t < T.lateVo - 0.6) return <Clean t={t} />;
  if (t < T.stormVo - 0.6) return <Late t={t} />;
  if (t < T.questionVo - 0.6) return <Storm t={t} />;
  return <Questions t={t} />;
}

const MAIN_Y = 900;
function MainLine({ x0 = 120, x1 = 1800, y = MAIN_Y, opacity = 1 }: { x0?: number; x1?: number; y?: number; opacity?: number }) {
  return (
    <>
      <div style={{ position: "absolute", left: x0, top: y - 8, width: x1 - x0, height: 16, background: C.amber, opacity }} />
      <Label x={x0} y={y + 44} color={C.amber} size={26} font={PIXEL} opacity={opacity}>MAIN</Label>
    </>
  );
}

/** One branch: up from main at x0, along at height y, ending at x1 (k = how much of it is drawn). */
function branchPath(x0: number, x1: number, y: number) {
  const r = Math.min(120, Math.abs(MAIN_Y - y));
  return `M ${x0} ${MAIN_Y} C ${x0 + r} ${MAIN_Y}, ${x0} ${y}, ${x0 + r} ${y} L ${x1} ${y}`;
}

// ── 1. branches fan out ──
function Fan({ t }: { t: number }) {
  const many = cue("fan", "With twenty");
  const one = fade(t, cue("fan", "Each agent copies"), 1.2);
  const k20 = smooth(clamp((t - many) / 2.2));
  const blind = fade(t, cue("fan", "none of them can see"), 0.5);
  const n = t < many ? 1 : 1 + Math.round(19 * k20);
  const ys = Array.from({ length: 20 }, (_, i) => 200 + i * 32);
  return (
    <Board t={t} from={T.fanVo - 0.6} title="HOW IT WORKS TODAY">
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }} shapeRendering="crispEdges">
        {ys.map((y, i) => {
          const k = i === 9 ? one : clamp(k20 * 1.4 - (Math.abs(i - 9) / 10) * 0.4);
          if (k <= 0) return null;
          const d = branchPath(300, 1460, y);
          return <path key={i} d={d} stroke={COLORS[i % COLORS.length]} strokeWidth={8} fill="none" pathLength={1} strokeDasharray={`${k} 1`} opacity={i === 9 || k20 > 0 ? 1 : 0} />;
        })}
      </svg>
      <MainLine />
      {ys.map((y, i) => {
        const k = i === 9 ? one : clamp(k20 * 1.4 - (Math.abs(i - 9) / 10) * 0.4);
        return k >= 0.98 ? <Robot key={i} x={1500} y={y} s={0.55} color={COLORS[i % COLORS.length]!} /> : null;
      })}
      {blind > 0 && ys.map((y, i) => <Label key={i} x={1560} y={y} size={30} color={C.red} opacity={blind}>?</Label>)}
      <Label x={1620} y={460} size={30} font={PIXEL} color={C.text}>AGENTS</Label>
      <Label x={1620} y={540} size={90} font={PIXEL} color={C.orange}>{n}</Label>
      <Label x={1620} y={640} size={36} color={C.dim} opacity={blind}>20 copies of main,</Label>
      <Label x={1620} y={684} size={36} color={C.dim} opacity={blind}>none can see the others</Label>
    </Board>
  );
}

// ── 2. merges clean, doesn't build ──
function CodeCard({ x, y, w, title, color, lines, ok, opacity = 1 }: { x: number; y: number; w: number; title: string; color: string; lines: Array<{ s: string; c?: string }>; ok?: { k: number; good: boolean; text: string }; opacity?: number }) {
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, opacity, background: C.panel, border: `6px solid ${color}`, boxShadow: "10px 10px 0 #0a0f24" }}>
      <div style={{ padding: "14px 20px 10px", background: color, color: C.night, font: `22px/1 ${PIXEL}` }}>{title}</div>
      <div style={{ padding: "18px 24px", font: `40px/1.35 ${TERM}`, color: C.text }}>
        {lines.map((l, i) => <div key={i} style={{ color: l.c ?? C.text, whiteSpace: "pre" }}>{l.s}</div>)}
      </div>
      {ok && <div style={{ padding: "0 24px 18px", font: `22px/1 ${PIXEL}`, color: ok.good ? C.green : C.red, opacity: ok.k }}>{ok.good ? "✓" : "✗"} {ok.text}</div>}
    </div>
  );
}

function Clean({ t }: { t: number }) {
  const a = fade(t, cue("clean", "One agent changes"), 0.5);
  const b = fade(t, cue("clean", "Another agent"), 0.5);
  const alone = fade(t, cue("clean", "Each change builds"), 0.4);
  const git = fade(t, cue("clean", "Git compares lines"), 0.4);
  const merged = fade(t, cue("clean", "so Git merges"), 0.4);
  const together = smooth(clamp((t - cue("clean", "The result")) / 0.8));
  const ax = 140 + together * 400, bx = 1000 - together * 460;
  return (
    <Board t={t} from={T.cleanVo - 0.6} title="MERGES CLEAN. DOESN'T BUILD.">
      {together < 1 && (
        <>
          <CodeCard x={ax} y={210} w={780} title="AGENT A · prices file" color={LIVERY.a} opacity={a * (1 - together)}
            lines={[{ s: "- function total(price, tax)", c: C.red }, { s: "+ function total(price, tax, coupon)", c: C.green }]}
            ok={{ k: alone, good: true, text: "BUILDS ON ITS OWN" }} />
          <CodeCard x={bx} y={210} w={780} title="AGENT B · checkout file" color={LIVERY.b} opacity={b * (1 - together)}
            lines={[{ s: "  const sum = cart.sum()" }, { s: "+ pay(total(sum, tax))", c: C.green }]}
            ok={{ k: alone, good: true, text: "BUILDS ON ITS OWN" }} />
        </>
      )}
      {git > 0 && together < 1 && (
        <div style={{ position: "absolute", left: 960, top: 640, transform: "translateX(-50%)", opacity: git * (1 - together), display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
          <div style={{ font: `36px/1.2 ${TERM}`, color: C.dim }}>different files, different lines</div>
          <div style={{ padding: "18px 28px 14px", border: `6px solid ${C.green}`, font: `30px/1 ${PIXEL}`, color: C.green, opacity: merged }}>GIT: NO CONFLICT ✓</div>
        </div>
      )}
      {together > 0 && (
        <CodeCard x={540} y={260} w={840} title="MAIN, AFTER BOTH MERGE" color={C.red} opacity={together}
          lines={[{ s: "function total(price, tax, coupon)" }, { s: "…" }, { s: "pay(total(sum, tax))", c: C.red }]}
          ok={{ k: fade(t, cue("clean", "The result") + 0.6), good: false, text: "DOESN'T BUILD: EXPECTED 3 ARGUMENTS, GOT 2" }} />
      )}
    </Board>
  );
}

// ── 3. found too late ──
function Lane({ y, who, color, fill, status, statusColor, children }: { y: number; who: string; color: string; fill: number; status?: string; statusColor?: string; children?: ReactNode }) {
  return (
    <>
      <Robot x={190} y={y} color={color} s={0.8} />
      <Label x={250} y={y} size={30} font={PIXEL} color={color}>{who}</Label>
      <div style={{ position: "absolute", left: 470, top: y - 30, width: 900, height: 60, border: `6px solid ${C.edge}` }}>
        <div style={{ width: `${fill * 100}%`, height: "100%", background: color }} />
      </div>
      {status && <Label x={1420} y={y} size={26} font={PIXEL} color={statusColor}>{status}</Label>}
      {children}
    </>
  );
}

function Late({ t }: { t: number }) {
  const t0 = T.lateVo - 0.6;
  const work = smooth(clamp((t - t0) / 1.6));
  const hit = cue("late", "tries to merge");
  const over = cue("late", "start over");
  const person = cue("late", "a person");
  const bFill = t < over ? work : Math.max(0, 1 - (t - over) / 0.8);
  const bStatus = t < hit ? (work >= 1 ? "DONE" : undefined) : t < over ? "BUILD BROKEN" : "START OVER";
  return (
    <Board t={t} from={t0} title="FOUND TOO LATE">
      <Lane y={380} who="A" color={LIVERY.a} fill={work} status={work >= 1 ? "MERGED" : undefined} statusColor={C.green} />
      <Lane y={560} who="B" color={t >= over ? C.dim : LIVERY.b} fill={bFill} status={bStatus} statusColor={t < hit ? C.green : C.red} />
      <div style={{ position: "absolute", left: 1376, top: 300, width: 12, height: 340, background: C.amber }} />
      <Label x={1382} y={270} size={22} font={PIXEL} color={C.amber} anchor="center">MERGE</Label>
      <Label x={470} y={720} size={40} color={C.dim} opacity={fade(t, cue("late", "both agents have finished"))}>Both agents have finished. The conflict shows up only here.</Label>
      <Person x={1800} y={720} opacity={fade(t, person)} />
      <Label x={1800} y={770} size={30} color={C.amber} anchor="center" opacity={fade(t, person)}>a person fixes it</Label>
    </Board>
  );
}

// ── 4. the rebase storm ──
function Storm({ t }: { t: number }) {
  const t0 = T.stormVo - 0.6;
  const start = cue("storm", "whenever main moves");
  const PERIOD = 1.4;
  const moves = t < start ? 0 : Math.floor((t - start) / PERIOD) + 1;
  const flash = t >= start && (t - start) % PERIOD < 0.7;
  const untouched = fade(t, cue("storm", "even if it never"));
  const N = 8;
  const ys = Array.from({ length: N }, (_, i) => 230 + i * 64);
  return (
    <Board t={t} from={t0} title="EVERY TIME MAIN MOVES">
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }} shapeRendering="crispEdges">
        {ys.map((y, i) => <path key={i} d={branchPath(260 + i * 18, 1180, y)} stroke={COLORS[i % COLORS.length]} strokeWidth={8} fill="none" />)}
      </svg>
      <MainLine x1={1300} />
      {Array.from({ length: Math.min(moves, 9) }, (_, i) => (
        <div key={i} style={{ position: "absolute", left: 1260 - i * 26, top: MAIN_Y - 22, width: 44, height: 44, background: C.amber, border: `6px solid ${C.night}` }} />
      ))}
      {ys.map((y, i) => (
        <div key={i} style={{ position: "absolute", left: 1200, top: y - 22, padding: "8px 12px 6px", font: `18px/1 ${PIXEL}`, background: flash ? C.amber : "transparent", color: flash ? C.night : C.dim, border: `4px solid ${flash ? C.amber : C.edge}` }}>
          REBASE + RETEST
        </div>
      ))}
      <div style={{ position: "absolute", left: 1520, top: 260, width: 330, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ font: `22px/1.3 ${PIXEL}`, color: C.text }}>MAIN MOVED</div>
        <div style={{ font: `80px/1 ${PIXEL}`, color: C.amber }}>{moves}×</div>
        <div style={{ font: `22px/1.3 ${PIXEL}`, color: C.text, marginTop: 30 }}>REBASES</div>
        <div style={{ font: `80px/1 ${PIXEL}`, color: C.red }}>{moves * N}</div>
        <div style={{ font: `36px/1.15 ${TERM}`, color: C.dim, marginTop: 30, opacity: untouched }}>Most of them never touched the same code.</div>
      </div>
    </Board>
  );
}

// ── the two questions ──
function Questions({ t }: { t: number }) {
  const t0 = T.questionVo - 0.6;
  const q1 = fade(t, cue("question", "Can an agent"), 0.5);
  const q2 = fade(t, cue("question", "And can something"), 0.5);
  const out = 1 - fade(t, T.probEnd - 0.5, 0.5);
  const row = (k: number, n: string, text: string) => (
    <div style={{ opacity: k, transform: `translateY(${(1 - k) * 20}px)`, display: "flex", gap: 30, alignItems: "baseline" }}>
      <span style={{ font: `40px/1 ${PIXEL}`, color: C.orange }}>{n}</span>
      <span style={{ font: `54px/1.15 ${TERM}`, color: C.text }}>{text}</span>
    </div>
  );
  return (
    <Board t={t} from={t0} title="TWO QUESTIONS" style={{ opacity: out }}>
      <div style={{ position: "absolute", left: 120, top: 400, width: 1720, display: "flex", flexDirection: "column", gap: 80 }}>
        {row(q1, "1", "Can an agent find out about a collision while it's still working?")}
        {row(q2, "2", "Can something decide the order, so only real collisions redo work?")}
      </div>
    </Board>
  );
}

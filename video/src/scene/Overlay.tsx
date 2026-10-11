/** Pieces that frame the whole video: the section strip, the three points, and a plain board for the problem graphics. */
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { clamp } from "./geometry";
import { C, PIXEL, TERM } from "./Stage";
import { POINT_AT, POINTS, SECTIONS } from "../timeline";

export const fade = (t: number, from: number, len = 0.4) => clamp((t - from) / len);
const POINT_COLOR = [C.cyan, C.red, C.green];

/** "PROBLEM · IDEA · DEMO · HOW · RECAP" in the top-right corner, with the current section lit. */
export function SectionStrip({ t }: { t: number }) {
  const cur = SECTIONS.findIndex((s) => t >= s.from && t < s.to);
  if (cur < 0) return null;
  const k = Math.min(fade(t, SECTIONS[0].from, 0.6), 1 - fade(t, SECTIONS[SECTIONS.length - 1]!.to - 0.4));
  return (
    <div style={{ position: "absolute", right: 40, top: 22, display: "flex", gap: 6, opacity: k }}>
      {SECTIONS.map((s, i) => (
        <div key={s.id} style={{ padding: "8px 12px 6px", font: `14px/1 ${PIXEL}`, background: i === cur ? C.orange : "rgba(15,21,48,0.8)", color: i === cur ? C.night : i < cur ? C.dim : C.text }}>{s.id}</div>
      ))}
    </div>
  );
}

/** During the demo: which of the three points is on screen. */
export function PointBadge({ t }: { t: number }) {
  const p = POINT_AT.find((x) => t >= x.from && t < x.to);
  if (!p) return null;
  const pt = POINTS[p.n - 1]!;
  const color = POINT_COLOR[p.n - 1]!;
  return (
    <div style={{ position: "absolute", left: 48, top: 112, display: "flex", alignItems: "center", gap: 14, padding: "10px 16px 8px", background: "rgba(15,21,48,0.92)", border: `4px solid ${color}`, opacity: fade(t, p.from, 0.5) }}>
      <Num n={p.n} color={color} size={34} />
      <span style={{ font: `18px/1 ${PIXEL}`, color }}>{pt.title}</span>
    </div>
  );
}

function Num({ n, color, size }: { n: number; color: string; size: number }) {
  return <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size * 1.5, height: size * 1.5, background: color, color: C.night, font: `${size}px/1 ${PIXEL}` }}>{n}</span>;
}

/** The three points as a card: each fades in at its cue; in the recap each gets a check and its proof line. */
export function PointsCard({ t, at, recap = false, opacity = 1 }: { t: number; at: number[]; recap?: boolean; opacity?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26, width: 1360, opacity }}>
      {POINTS.map((p, i) => {
        const k = fade(t, at[i]!);
        const color = POINT_COLOR[i]!;
        return (
          <div key={p.n} style={{ opacity: k, transform: `translateX(${(1 - k) * -40}px)`, display: "flex", alignItems: "center", gap: 34, padding: "22px 30px 18px", background: "rgba(15,21,48,0.95)", border: `6px solid ${color}`, boxShadow: "8px 8px 0 #0f1530" }}>
            <Num n={p.n} color={color} size={44} />
            <div style={{ flex: 1 }}>
              <div style={{ font: `30px/1.2 ${PIXEL}`, color }}>{p.title}</div>
              {recap && <div style={{ font: `40px/1.15 ${TERM}`, color: C.text, marginTop: 10 }}>{p.proof}</div>}
            </div>
            {recap && <span style={{ font: `56px/1 ${PIXEL}`, color: C.green, opacity: fade(t, at[i]! + 0.6) }}>✓</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A plain dark board for the problem graphics: no airport yet. */
export function Board({ children, title, t, from, style }: { children: ReactNode; title?: string; t: number; from: number; style?: CSSProperties }) {
  return (
    <AbsoluteFill style={{ background: C.night, ...style }}>
      <AbsoluteFill style={{ backgroundImage: `linear-gradient(${C.panel} 2px, transparent 2px), linear-gradient(90deg, ${C.panel} 2px, transparent 2px)`, backgroundSize: "48px 48px", opacity: 0.6 }} />
      {title && <div style={{ position: "absolute", left: 80, top: 70, font: `34px/1.2 ${PIXEL}`, color: C.amber, opacity: fade(t, from, 0.5) }}>{title}</div>}
      {children}
    </AbsoluteFill>
  );
}

/** A small pixel robot: one agent. */
export function Robot({ x, y, color, s = 1, opacity = 1 }: { x: number; y: number; color: string; s?: number; opacity?: number }) {
  const u = 6 * s;
  return (
    <div style={{ position: "absolute", left: x - 4 * u, top: y - 4 * u, width: 8 * u, height: 8 * u, opacity }}>
      <div style={{ position: "absolute", left: 3.5 * u, top: 0, width: u, height: u, background: color }} />
      <div style={{ position: "absolute", left: u, top: u, width: 6 * u, height: 4 * u, background: color }} />
      <div style={{ position: "absolute", left: 2 * u, top: 2 * u, width: u, height: u, background: C.night }} />
      <div style={{ position: "absolute", left: 5 * u, top: 2 * u, width: u, height: u, background: C.night }} />
      <div style={{ position: "absolute", left: 2 * u, top: 5 * u, width: 4 * u, height: 3 * u, background: color, opacity: 0.8 }} />
    </div>
  );
}

/** A small pixel person. */
export function Person({ x, y, opacity = 1 }: { x: number; y: number; opacity?: number }) {
  const u = 8;
  return (
    <div style={{ position: "absolute", left: x - 3 * u, top: y - 9 * u, width: 6 * u, height: 9 * u, opacity }}>
      <div style={{ position: "absolute", left: 1.5 * u, top: 0, width: 3 * u, height: 3 * u, background: "#f3c9a0" }} />
      <div style={{ position: "absolute", left: 0.5 * u, top: 3.5 * u, width: 5 * u, height: 3.5 * u, background: C.amber }} />
      <div style={{ position: "absolute", left: 1 * u, top: 7 * u, width: 1.5 * u, height: 2 * u, background: C.edge }} />
      <div style={{ position: "absolute", left: 3.5 * u, top: 7 * u, width: 1.5 * u, height: 2 * u, background: C.edge }} />
    </div>
  );
}

export function Label({ x, y, children, color = C.text, size = 34, font = TERM, anchor = "left", opacity = 1 }: { x: number; y: number; children: ReactNode; color?: string; size?: number; font?: string; anchor?: "left" | "center" | "right"; opacity?: number }) {
  const tx = anchor === "left" ? "0" : anchor === "center" ? "-50%" : "-100%";
  return <div style={{ position: "absolute", left: x, top: y, transform: `translate(${tx}, -50%)`, font: `${size}px/1.2 ${font}`, color, whiteSpace: "nowrap", opacity }}>{children}</div>;
}

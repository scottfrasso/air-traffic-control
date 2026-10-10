import { loadFont as loadPixel } from "@remotion/google-fonts/PressStart2P";
import { loadFont as loadTerm } from "@remotion/google-fonts/VT323";
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { drawScene, type Scene } from "./draw";
import { H, SCALE, W } from "./geometry";

export const PIXEL = loadPixel("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily;
export const TERM = loadTerm("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily;
export const C = { night: "#0f1530", panel: "#161f42", edge: "#2d3b6e", text: "#eef2ff", dim: "#8f9dcc", orange: "#f38020", amber: "#faae40", red: "#ff5757", green: "#62e07c", cyan: "#78d7ff" };

/** The airport canvas, drawn at 480×270 and scaled ×4 with hard pixels. */
export function Stage({ scene, children, style }: { scene: Scene; children?: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) drawScene(ctx, scene);
  });
  return (
    <AbsoluteFill style={{ backgroundColor: C.night, ...style }}>
      <canvas ref={ref} width={W} height={H} style={{ width: W * SCALE, height: H * SCALE, imageRendering: "pixelated" }} />
      {children}
    </AbsoluteFill>
  );
}

/** Place something at a logical-pixel point, anchored by its bottom centre. */
export function At({ x, y, children, anchor = "bottom", align = "center" }: { x: number; y: number; children: ReactNode; anchor?: "bottom" | "top" | "center"; align?: "center" | "edge" }) {
  const ty = anchor === "bottom" ? "-100%" : anchor === "top" ? "0" : "-50%";
  // "edge": slide the label along so it never leaves the frame (left-aligned at the left edge, right-aligned at the right).
  const tx = align === "edge" ? `${-Math.min(100, Math.max(0, (x - 20) / (W - 40))) * 100}%` : "-50%";
  return <div style={{ position: "absolute", left: x * SCALE, top: y * SCALE, transform: `translate(${tx}, ${ty})`, whiteSpace: "nowrap" }}>{children}</div>;
}

/** The label a plane carries, with an optional status light (CI, or ATC's check). */
export function Tag({ text, light, bg = "rgba(15,21,48,0.88)", opacity = 1, below = false }: { text: string; light?: { color: string; text: string }; bg?: string; opacity?: number; below?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 12px 4px", background: bg, color: C.text, font: `34px/1 ${TERM}`, opacity, marginBottom: below ? 0 : 20, marginTop: below ? 20 : 0 }}>
      {light && <span style={{ display: "inline-block", width: 14, height: 14, background: light.color, boxShadow: `0 0 10px ${light.color}` }} />}
      {light && <span style={{ font: `14px/1 ${PIXEL}`, color: light.color }}>{light.text}</span>}
      <span>{text}</span>
    </div>
  );
}

/** A labelled pointer from a box down (or up) to a point in the scene. */
export function Callout({ x, y, title, sub, rise = 60, opacity = 1, color = C.amber }: { x: number; y: number; title: string; sub?: string; rise?: number; opacity?: number; color?: string }) {
  return (
    <div style={{ position: "absolute", left: x * SCALE, top: (y - rise) * SCALE, transform: "translate(-50%, -100%)", opacity, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ padding: "14px 20px 10px", background: "rgba(15,21,48,0.94)", border: `4px solid ${color}`, textAlign: "center" }}>
        <div style={{ font: `24px/1.2 ${PIXEL}`, color }}>{title}</div>
        {sub && <div style={{ font: `32px/1.1 ${TERM}`, color: C.text, marginTop: 8 }}>{sub}</div>}
      </div>
      <div style={{ position: "absolute", top: "100%", width: 8, height: rise * SCALE - 8, background: color }} />
    </div>
  );
}

/** An event popup floating up from a plane (age 0..1). */
export function Popup({ text, color, age }: { text: string; color: string; age: number }) {
  if (age < 0 || age > 1) return null;
  return (
    <div style={{ transform: `translateY(${-age * 50}px)`, opacity: 1 - age * age, padding: "6px 10px", background: "rgba(15,21,48,0.92)", color, font: `24px/1 ${PIXEL}`, marginBottom: 74 }}>{text}</div>
  );
}

/** Caption band over the ground at the bottom of the frame. */
export function Caption({ children, opacity = 1, color = C.text }: { children: ReactNode; opacity?: number; color?: string }) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 40, display: "flex", justifyContent: "center", opacity }}>
      <div style={{ padding: "16px 28px 12px", background: "rgba(15,21,48,0.9)", border: `4px solid ${C.edge}`, color, font: `26px/1.3 ${PIXEL}`, textAlign: "center" }}>{children}</div>
    </div>
  );
}

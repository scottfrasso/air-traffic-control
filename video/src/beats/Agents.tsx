/**
 * After the recorded run: the same protocol works with real coding agents. The MCP tools and the outcome of the
 * two-agent run verified on 2026-10-10 (ADR-0015). That run wasn't recorded, so this is a summary card, not footage.
 */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import type { Plane } from "../scene/geometry";
import { fade } from "../scene/Overlay";
import { C, PIXEL, Stage, TERM } from "../scene/Stage";
import { cue, T } from "../timeline";
import { LIV, PRS, where } from "./RealRun";

const TOOLS = [
  { name: "start_work", what: "a fork of its own, plus git commands" },
  { name: "declare_intent", what: "what it plans to touch, and who is nearby" },
  { name: "get_signals", what: "who it collides with, and why" },
  { name: "get_clearance", what: "its instruction and the reason" },
  { name: "request_land", what: "ATC merges it and checks main" },
];

const OUTCOME = [
  { text: "Agent 1 landed first", color: C.green, phrase: "One landed first" },
  { text: "Agent 2: GO AROUND", color: C.red, phrase: "The other was told" },
  { text: "merged main, fixed the new call", color: C.text, phrase: "merged the new main" },
  { text: "Agent 2 landed. Main builds.", color: C.green, phrase: "and landed" },
  { text: "Human help: none", color: C.amber, phrase: "Nobody stepped in" },
];

export function Agents({ t }: { t: number }) {
  const parked: Plane[] = PRS.map((pr) => { const w = where(pr, t); return { id: pr, x: w.p[0], y: w.p[1], face: w.face, livery: LIV[pr]! }; });
  const scene: Scene = { t, planes: parked };
  const k = fade(t, T.agentsVo - 0.3, 0.5) * (1 - fade(t, T.agentsEnd - 0.4));
  const tools = fade(t, cue("agents", "They connect"));
  return (
    <Stage scene={scene}>
      <AbsoluteFill style={{ background: `rgba(15,21,48,${0.7 * k})` }} />
      <div style={{ position: "absolute", left: 100, top: 110, width: 1720, opacity: k }}>
        <div style={{ font: `30px/1.2 ${PIXEL}`, color: C.amber }}>TWO REAL CLAUDE CODE AGENTS, TASKS THAT COLLIDE</div>
        <div style={{ font: `32px/1.2 ${TERM}`, color: C.dim, marginTop: 10 }}>run on deployed Cloudflare resources, 2026-10-10 · not the recording you just saw</div>
        <div style={{ display: "grid", gridTemplateColumns: "1040px 1fr", gap: 40, marginTop: 40 }}>
          <div style={{ opacity: tools, padding: "22px 28px", background: "rgba(15,21,48,0.95)", border: `6px solid ${C.cyan}` }}>
            <div style={{ font: `22px/1 ${PIXEL}`, color: C.cyan, marginBottom: 20 }}>ATC'S MCP TOOLS</div>
            {TOOLS.map((x) => (
              <div key={x.name} style={{ display: "grid", gridTemplateColumns: "320px 1fr", font: `40px/1.5 ${TERM}` }}>
                <span style={{ color: C.cyan }}>{x.name}</span>
                <span style={{ color: C.text }}>{x.what}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {OUTCOME.map((o) => (
              <div key={o.text} style={{ opacity: fade(t, cue("agents", o.phrase) - 0.2), padding: "14px 22px 10px", background: "rgba(15,21,48,0.95)", border: `4px solid ${C.edge}`, font: `40px/1.15 ${TERM}`, color: o.color }}>{o.text}</div>
            ))}
          </div>
        </div>
      </div>
    </Stage>
  );
}

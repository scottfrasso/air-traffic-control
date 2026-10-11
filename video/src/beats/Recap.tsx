/** Part 3: say what the video showed. The three points again, each checked off with its proof; what's next; the close. */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import type { Plane } from "../scene/geometry";
import { fade, PointsCard } from "../scene/Overlay";
import { C, PIXEL, Stage, TERM } from "../scene/Stage";
import { cue, RUN, T } from "../timeline";
import { LIV, PRS, where } from "./RealRun";

export function Recap({ t }: { t: number }) {
  const parked: Plane[] = PRS.map((pr) => { const w = where(pr, t); return { id: pr, x: w.p[0], y: w.p[1], face: w.face, livery: LIV[pr]! }; });
  const scene: Scene = { t, planes: parked };
  const closing = t >= T.closeStart;
  const k = fade(t, T.recapStart, 0.6);
  const next = fade(t, T.nextVo - 0.2, 0.5);
  return (
    <Stage scene={scene}>
      <AbsoluteFill style={{ background: `rgba(15,21,48,${0.72 * k})` }} />
      {!closing && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 36, opacity: k }}>
          <div style={{ font: `30px/1 ${PIXEL}`, color: C.amber, alignSelf: "flex-start", marginLeft: 280 }}>WHAT YOU SAW</div>
          <PointsCard t={t} recap at={[cue("recap", "ATC sees"), cue("recap", "It warns"), cue("recap", "And it decides")]} />
          <div style={{ width: 1360, opacity: next, padding: "18px 30px 14px", border: `4px dashed ${C.dim}`, display: "flex", gap: 30, alignItems: "baseline" }}>
            <span style={{ font: `24px/1 ${PIXEL}`, color: C.dim }}>NEXT</span>
            <span style={{ font: `40px/1.15 ${TERM}`, color: C.text }}>Every landed commit keeps the reasons behind it.</span>
          </div>
        </AbsoluteFill>
      )}
      {closing && <Close t={t} />}
    </Stage>
  );
}

function Close({ t }: { t: number }) {
  const k = fade(t, T.closeStart, 0.6);
  return (
    <AbsoluteFill style={{ background: `rgba(15,21,48,${0.78 * k})`, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 34, opacity: k }}>
      <div style={{ font: `150px/1 ${PIXEL}`, color: C.orange, textShadow: "10px 10px 0 #000" }}>ATC</div>
      <div style={{ font: `34px/1.3 ${PIXEL}`, color: C.amber }}>AIR TRAFFIC CONTROL FOR CODING AGENTS</div>
      <div style={{ font: `40px/1.2 ${TERM}`, color: C.text, marginTop: 20 }}>Built on Cloudflare: Workers · Artifacts · Durable Objects · Workflows · Sandbox · MCP</div>
      <div style={{ font: `36px/1.2 ${TERM}`, color: C.cyan }}>github.com/scottfrasso/air-traffic-control</div>
      <div style={{ font: `30px/1.2 ${TERM}`, color: C.dim }}>The run in this video: {RUN.baseline}, recorded {RUN.recordedAt.slice(0, 10)}</div>
    </AbsoluteFill>
  );
}

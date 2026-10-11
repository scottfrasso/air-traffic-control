/**
 * Part 1: say what the video will show. Busy sky (many agents at once), the title, the three points, then the
 * roadmap of the sections. Illustration, not a recording.
 */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import { clamp, LIVERY, type Plane } from "../scene/geometry";
import { fade, PointsCard } from "../scene/Overlay";
import { C, PIXEL, Stage, TERM } from "../scene/Stage";
import { cue, SECTIONS, T } from "../timeline";

// Planes crossing the sky in both directions, never landing: lots of agents, nobody coordinating.
const TRAFFIC = Object.values(LIVERY).flatMap((livery, i) => [
  { livery, y: 30 + i * 22, speed: 26 + i * 5, phase: i * 61, dir: 1 as const },
  { livery, y: 44 + i * 23, speed: 21 + i * 4, phase: i * 97 + 40, dir: -1 as const },
]);

export function Opening({ t }: { t: number }) {
  const planes: Plane[] = TRAFFIC.map((p, i) => {
    const span = 560;
    const x = ((p.phase + t * p.speed) % span) - 40;
    return { id: `o${i}`, x: p.dir === 1 ? x : 480 - x, y: p.y, face: p.dir, livery: p.livery };
  });
  const scene: Scene = { t, planes };
  const title = fade(t, T.titleVo - 0.2, 0.6) * (1 - fade(t, T.agendaVo - 0.6, 0.5));
  const agenda = fade(t, T.agendaVo - 0.3, 0.5);
  const dim = Math.max(title, agenda) * 0.7;
  const roadmap = fade(t, T.roadmapVo - 0.2);
  const lit = [cue("roadmap", "problem"), cue("roadmap", "idea"), cue("roadmap", "recorded run"), cue("roadmap", "how it's built"), cue("roadmap", "recap")];
  return (
    <Stage scene={scene}>
      <AbsoluteFill style={{ background: `rgba(15,21,48,${dim})` }} />
      {title > 0 && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 36, opacity: title }}>
          <div style={{ font: `150px/1 ${PIXEL}`, color: C.orange, textShadow: "10px 10px 0 #0f1530" }}>ATC</div>
          <div style={{ font: `30px/1.4 ${PIXEL}`, color: C.amber }}>AIR TRAFFIC CONTROL</div>
          <div style={{ font: `48px/1.2 ${TERM}`, color: C.text }}>for many coding agents working on one repo</div>
          <div style={{ font: `26px/1.2 ${PIXEL}`, color: C.orange, marginTop: 10 }}>BUILT ON CLOUDFLARE</div>
        </AbsoluteFill>
      )}
      {agenda > 0 && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 40, opacity: agenda }}>
          <div style={{ font: `30px/1 ${PIXEL}`, color: C.amber, alignSelf: "flex-start", marginLeft: 280 }}>WHAT YOU'LL SEE</div>
          <PointsCard t={t} at={[cue("agenda", "First"), cue("agenda", "Second"), cue("agenda", "And third")]} />
          <div style={{ display: "flex", gap: 12, opacity: roadmap }}>
            {SECTIONS.map((s, i) => {
              const on = t >= lit[i]! - 0.1;
              return <div key={s.id} style={{ padding: "12px 18px 10px", font: `20px/1 ${PIXEL}`, background: on ? C.orange : "rgba(15,21,48,0.9)", color: on ? C.night : C.dim, border: `4px solid ${on ? C.orange : C.edge}`, transform: `scale(${on ? 1 + 0.08 * clamp(1 - (t - lit[i]!) / 0.5) : 1})` }}>{s.id}</div>;
            })}
          </div>
        </AbsoluteFill>
      )}
    </Stage>
  );
}

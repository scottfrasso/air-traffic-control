/**
 * Part 2b: the idea. The airport appears for the first time and each part is named (change = plane,
 * main = runway, ATC = tower), then the five clearances. Illustration, not a recording.
 */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import { clamp, glide, LIVERY, RUNWAY, TOWER, type Plane } from "../scene/geometry";
import { fade } from "../scene/Overlay";
import { C, Callout, Caption, PIXEL, Stage, TERM } from "../scene/Stage";
import { cue, T } from "../timeline";

const CLEARANCES = [
  { word: "CLEARED", color: C.green, what: "cleared to land", phrase: "Cleared to land" },
  { word: "FOLLOW", color: C.text, what: "follow the plane ahead", phrase: "Follow the plane" },
  { word: "HOLD", color: C.amber, what: "wait while a conflicting plane lands first", phrase: "Hold" },
  { word: "GO AROUND", color: C.red, what: "rebase on the new main, then land", phrase: "Go around" },
  { word: "STANDBY", color: C.cyan, what: "checks are still running", phrase: "Or stand by" },
];

export function Idea({ t }: { t: number }) {
  const t0 = T.probEnd;
  const show = fade(t, t0, 0.8);
  // Three planes drift in on the approach and sit there; nobody lands in this beat.
  const planes: Plane[] = [0.62, 0.45, 0.28].map((s, i) => {
    const k = clamp((t - t0 - i * 0.5) / 3);
    const [x, y] = glide(s - 0.4 * (1 - k));
    return { id: `i${i}`, x, y, face: 1, livery: [LIVERY.a, LIVERY.b, LIVERY.c][i]! };
  });
  const scene: Scene = { t, planes, towerLight: t > cue("map", "ATC is the tower") && Math.floor(t * 3) % 2 === 0 ? C.cyan : undefined };
  const lead = planes[0]!;
  const list = fade(t, T.clearVo - 0.4, 0.5);
  return (
    <Stage scene={scene} style={{ opacity: show }}>
      {list < 1 && (
        <AbsoluteFill style={{ opacity: 1 - list }}>
          <Callout x={lead.x} y={lead.y - 6} rise={34} title="A PLANE" sub="one agent's change" opacity={fade(t, cue("map", "each agent's change"))} />
          <Callout x={RUNWAY.x + RUNWAY.w / 2} y={RUNWAY.y - 4} rise={70} title="THE RUNWAY" sub="main" opacity={fade(t, cue("map", "Main is the runway"))} />
          <Callout x={TOWER.x} y={TOWER.top - 6} rise={44} title="THE TOWER" sub="ATC" color={C.cyan} opacity={fade(t, cue("map", "ATC is the tower"))} />
          <Caption opacity={fade(t, cue("map", "landing means"))}>Landing = merging into <span style={{ color: C.amber }}>main</span></Caption>
        </AbsoluteFill>
      )}
      {list > 0 && (
        <AbsoluteFill style={{ background: `rgba(15,21,48,${0.75 * list})`, alignItems: "center", justifyContent: "center" }}>
          <div style={{ opacity: list, width: 1300, display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ font: `30px/1 ${PIXEL}`, color: C.amber, marginBottom: 16 }}>ONE INSTRUCTION, ONE REASON</div>
            {CLEARANCES.map((c) => {
              const k = fade(t, cue("clearances", c.phrase) - 0.2);
              return (
                <div key={c.word} style={{ opacity: k, display: "grid", gridTemplateColumns: "340px 1fr", alignItems: "center", padding: "16px 26px 12px", background: "rgba(15,21,48,0.95)", border: `6px solid ${k > 0 && t < cue("clearances", c.phrase) + 2.5 ? c.color : C.edge}` }}>
                  <span style={{ font: `30px/1 ${PIXEL}`, color: c.color }}>{c.word}</span>
                  <span style={{ font: `46px/1.1 ${TERM}`, color: C.text }}>{c.what}</span>
                </div>
              );
            })}
          </div>
        </AbsoluteFill>
      )}
    </Stage>
  );
}

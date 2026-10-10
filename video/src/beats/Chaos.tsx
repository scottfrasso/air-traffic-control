/**
 * Beat 0: the metaphor. Each PR is a plane landing on main. On GitHub nobody is in the tower, so every PR lands
 * whenever it's ready; then the title: we built the controller. Illustration, not a recording.
 */
import { AbsoluteFill } from "remotion";
import type { Scene } from "../scene/draw";
import { clamp, LIVERY, path, RUNWAY, TOUCHDOWN, TOWER, type Plane } from "../scene/geometry";
import { At, C, Callout, Caption, PIXEL, Popup, Stage, Tag, TERM } from "../scene/Stage";
import { T, voSeconds } from "../timeline";

const I = voSeconds("intro");
const at = (k: number) => T.introVo + k * I;
const END = RUNWAY.x + RUNWAY.w - 14;

type Fate = "land" | "around";
const PLANES: Array<{ id: keyof typeof LIVERY; pr: string; y0: number; enter: number; arrive: number; fate: Fate; pop?: string }> = [
  { id: "c", pr: "PR #14", y0: 40, enter: 0.0, arrive: 0.66, fate: "land" },
  { id: "a", pr: "PR #15", y0: 120, enter: 0.05, arrive: 0.72, fate: "around", pop: "BUILD BROKEN" },
  { id: "d", pr: "PR #16", y0: 80, enter: 0.12, arrive: 0.79, fate: "land", pop: "MERGED BROKEN CODE" },
  { id: "b", pr: "PR #17", y0: 160, enter: 0.18, arrive: 0.85, fate: "around", pop: "CONFLICT" },
  { id: "e", pr: "PR #18", y0: 20, enter: 0.24, arrive: 0.91, fate: "around", pop: "CI FAILED" },
];

function fly(p: (typeof PLANES)[number], t: number): Plane {
  const t0 = at(p.enter), ta = at(p.arrive);
  const keys: Array<[number, number, number]> = [[t0, -20, p.y0], [ta - 1.6, 250 + p.y0 * 0.2, 150 + p.y0 * 0.25], [ta, TOUCHDOWN.x, TOUCHDOWN.y]];
  if (p.fate === "land") keys.push([ta + 1.2, END, TOUCHDOWN.y], [ta + 30, END, TOUCHDOWN.y]);
  else keys.splice(2, 1, [ta - 0.1, TOUCHDOWN.x - 14, TOUCHDOWN.y - 6], [ta + 0.6, 440, 186], [ta + 1.8, 540, 90]);
  const { p: xy, v } = path(keys, t);
  return { id: p.id, x: xy[0], y: xy[1], face: v[0] < 0 ? -1 : 1, livery: LIVERY[p.id] };
}

export function Chaos({ t }: { t: number }) {
  const planes = PLANES.map((p) => ({ p, plane: fly(p, t) }));
  const titleK = clamp((t - T.intro2Vo + 0.2) / 0.6);
  const scene: Scene = { t, planes: planes.map((x) => x.plane), towerLight: t > T.intro2Vo + 0.6 && Math.floor(t * 3) % 2 === 0 ? C.cyan : undefined };
  const show = (k: number) => clamp((t - at(k)) / 0.4);
  return (
    <Stage scene={scene}>
      {titleK < 1 &&
        planes.map(({ p, plane }) => (
          <div key={p.id}>
            {t < at(p.arrive) && <At x={plane.x} y={plane.y - 8} align="edge"><Tag text={p.pr} opacity={show(p.enter + 0.08) * (1 - titleK)} /></At>}
            {p.pop && <At x={plane.x} y={plane.y}><Popup text={p.pop} color={p.fate === "land" ? C.amber : C.red} age={(t - at(p.arrive)) / 2.2} /></At>}
          </div>
        ))}
      {titleK < 1 && <Callout x={TOWER.x} y={TOWER.top - 8} rise={40} title="NO CONTROLLER" color={C.red} opacity={show(0.33) * (1 - titleK)} />}
      {titleK < 1 && t < at(0.33) && <Caption opacity={show(0.02)}>Each pull request is a plane landing on <span style={{ color: C.amber }}>main</span></Caption>}
      {titleK < 1 && t >= at(0.55) && <Caption opacity={show(0.55) * (1 - titleK)}><span style={{ color: C.amber }}>GITHUB:</span> every PR lands when it's ready</Caption>}
      {titleK > 0 && <Title k={titleK} fadeOut={clamp((t - T.setupStart + 0.5) / 0.5)} />}
    </Stage>
  );
}

function Title({ k, fadeOut }: { k: number; fadeOut: number }) {
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 36, opacity: k * (1 - fadeOut), background: `rgba(15,21,48,${0.55 * k})` }}>
      <div style={{ font: `150px/1 ${PIXEL}`, color: C.orange, textShadow: "10px 10px 0 #0f1530" }}>ATC</div>
      <div style={{ font: `30px/1.4 ${PIXEL}`, color: C.amber }}>AIR TRAFFIC CONTROL</div>
      <div style={{ font: `48px/1.2 ${TERM}`, color: C.text }}>for AI coding agents merging pull requests into one repo</div>
    </AbsoluteFill>
  );
}

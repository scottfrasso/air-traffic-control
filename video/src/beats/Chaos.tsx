/**
 * The airport without a tower: every change lands whenever it's ready, and some break main or are sent around.
 * Illustration, not a recording.
 */
import type { Scene } from "../scene/draw";
import { clamp, LIVERY, path, RUNWAY, TOUCHDOWN, TOWER, type Plane } from "../scene/geometry";
import { At, C, Callout, Caption, Popup, Stage, Tag } from "../scene/Stage";
import { T } from "../timeline";

const at = (k: number) => T.chaosVo + k * T.CHAOS;
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
  const scene: Scene = { t, planes: planes.map((x) => x.plane) };
  const show = (k: number) => clamp((t - at(k)) / 0.4);
  return (
    <Stage scene={scene}>
      {planes.map(({ p, plane }) => (
        <div key={p.id}>
          {t < at(p.arrive) && <At x={plane.x} y={plane.y - 8} align="edge"><Tag text={p.pr} opacity={show(p.enter + 0.08)} /></At>}
          {p.pop && <At x={plane.x} y={plane.y}><Popup text={p.pop} color={p.fate === "land" ? C.amber : C.red} age={(t - at(p.arrive)) / 2.2} /></At>}
        </div>
      ))}
      <Callout x={TOWER.x} y={TOWER.top - 8} rise={40} title="NO CONTROLLER" color={C.red} opacity={show(0.33)} />
      {t < at(0.33) && <Caption opacity={show(0.02)}>Each change is a plane landing on <span style={{ color: C.amber }}>main</span></Caption>}
      {t >= at(0.55) && <Caption opacity={show(0.55)}><span style={{ color: C.amber }}>NO TOWER:</span> every change lands when it's ready</Caption>}
    </Stage>
  );
}


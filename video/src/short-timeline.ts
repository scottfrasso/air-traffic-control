/**
 * The LinkedIn cut (ATCShort): its own narration (short-script.ts) over clips of the long video. Each line plays
 * over one or more stretches of the long timeline, sped up or slowed to fit the line, or over a card of its own.
 */
import shortMatilda from "./data/vo.short.matilda.json";
import shortScott from "./data/vo.short.scott.json";
import { SHORT_LINES, type ShortLineId } from "./data/short-script";
import { T, VOICE_KEY } from "./timeline";

const vo: Record<ShortLineId, { file: string; seconds: number }> = VOICE_KEY === "scott" ? shortScott : shortMatilda;
const d = (id: ShortLineId) => vo[id].seconds;

type Clip = [from: number, to: number];
/** What plays under each line: clips of the long video, or a card. */
const PLAN: Array<{ id: ShortLineId; clips?: Clip[]; card?: "numbers" | "log"; pad: number }> = [
  { id: "hook", clips: [[0.8, T.titleVo - 0.4]], pad: 0.6 },
  { id: "hidden", clips: [[T.cleanVo, T.lateVo - 0.4]], pad: 0.8 },
  { id: "idea", clips: [[T.titleVo - 0.2, T.agendaVo - 0.8], [T.mapVo, T.clearVo]], pad: 0.6 },
  { id: "run", clips: [[T.b4, T.orderVo]], pad: 0.4 },
  { id: "order", clips: [[T.holdVo - 1, T.b4End]], pad: 2.2 },
  { id: "numbers", card: "numbers", pad: 0.8 },
  { id: "log", card: "log", pad: 0.8 },
  { id: "close", clips: [[T.closeStart, T.end]], pad: 1.6 },
];

export type ShortSegment = { id: ShortLineId; start: number; end: number; voAt: number; clips?: Clip[]; card?: "numbers" | "log" };
const LEAD = 0.3;
export const SEGMENTS: ShortSegment[] = (() => {
  let t = 0;
  return PLAN.map((p) => {
    const start = t;
    const end = start + LEAD + d(p.id) + p.pad;
    t = end;
    return { id: p.id, start, end, voAt: start + LEAD, clips: p.clips, card: p.card };
  });
})();
export const SHORT_END = SEGMENTS[SEGMENTS.length - 1]!.end;
export const shortVoFile = (id: ShortLineId) => vo[id].file;

/** Short-video seconds → long-video seconds for the segment's clips (null on a card). */
export function longTime(seg: ShortSegment, t: number): number | null {
  if (!seg.clips) return null;
  const total = seg.clips.reduce((s, [a, b]) => s + (b - a), 0);
  let x = ((t - seg.start) / (seg.end - seg.start)) * total;
  for (const [a, b] of seg.clips) {
    if (x <= b - a) return a + x;
    x -= b - a;
  }
  const last = seg.clips[seg.clips.length - 1]!;
  return last[1];
}

/** The line on screen as captions: sentences (long ones split at commas), each shown for its share of the line. */
export function caption(seg: ShortSegment, t: number): string | null {
  const text: string = SHORT_LINES[seg.id];
  if (t < seg.voAt || t > seg.voAt + d(seg.id) + 0.3) return null;
  const chunks = text.split(/(?<=[.?!])\s+/).flatMap((s) => (s.length > 70 ? s.split(/(?<=,)\s+/) : [s]));
  const at = ((t - seg.voAt) / d(seg.id)) * text.length;
  let n = 0;
  for (const c of chunks) {
    n += c.length + 1;
    if (at < n) return c;
  }
  return chunks[chunks.length - 1]!;
}

/**
 * Every time in the video (v8), in seconds, derived from the voice-over lengths (src/data/vo.json) and the
 * recorded run (src/data/run.json). Beat 4 maps the run's real clock onto video time piecewise, so each
 * real event lands on the line that describes it; the on-screen clock always shows real time.
 */
import run from "./data/run.json";
import voMatilda from "./data/vo.json";
import voScott from "./data/vo.scott.json";
import { LINES, VOICES, type LineId, type VoiceKey } from "./data/script";

/** Which voice to render: `REMOTION_VOICE=scott pnpm render…` (Remotion passes REMOTION_* env vars into the bundle). */
export const VOICE_KEY: VoiceKey = process.env.REMOTION_VOICE === "scott" ? "scott" : "matilda";
if (!(VOICE_KEY in VOICES)) throw new Error(`unknown voice ${VOICE_KEY}`);
const vo: Record<LineId, { file: string; seconds: number }> = VOICE_KEY === "scott" ? voScott : voMatilda;

export const FPS = 30;
const d = (id: LineId) => vo[id].seconds;

type Ev = (typeof run.events)[number];
const find = (pred: (e: Ev) => boolean, what: string): number => {
  const e = run.events.find(pred);
  if (!e) throw new Error(`run.json has no ${what}`);
  return e.t;
};
const pushesA = run.events.filter((e) => e.kind === "push.received" && e.pr === run.a);
type Seq = (typeof run.sequences)[number];
const firstSeq = (pred: (s: Seq) => boolean, what: string): Seq => {
  const s = run.sequences.find(pred);
  if (!s) throw new Error(`run.json has no ${what}`);
  return s;
};
const conflictEvent = run.events.find((e) => e.kind === "check.pair" && e.detail?.status === "semantic_conflict");
export const ERROR = String(conflictEvent?.detail?.errors?.[0] ?? ""); // "src/walk-in.ts:5 TS2554 Expected 3 arguments, but got 2"
const fixT = pushesA[1]?.t ?? NaN;
/** The first ordering ATC settled on (PR1 holding), and the one after PR1's fix. */
export const SEQ1 = firstSeq((s) => s.sequence.some((x) => x.clearance === "hold"), "hold");
export const SEQ2 = firstSeq((s) => s.t > fixT && s.sequence.length === 5 && !s.sequence.some((x) => x.clearance === "checking"), "settled sequence after the fix");
export const LANDS = run.events.filter((e) => e.kind === "land.merged").map((e) => ({ pr: e.pr!, t: e.t }));
/** Each unordered pair's first fresh check: when it finished and how. */
export const PAIRS = (() => {
  const seen = new Map<string, { a: string; b: string; status: string; t: number }>();
  for (const e of run.events) {
    if (e.kind !== "check.pair" || !e.detail?.fresh || e.t > fixT) continue;
    const [x, y] = [String(e.detail.a), String(e.detail.b)].sort();
    const k = `${x}|${y}`;
    if (!seen.has(k)) seen.set(k, { a: x!, b: y!, status: String(e.detail.status), t: e.t });
  }
  return [...seen.values()];
})();
/** Real seconds since the first push, for the moments beat 4 shows. */
export const REAL = {
  push: 0,
  conflict: conflictEvent?.t ?? NaN,
  settled: SEQ1.t,
  fix: fixT,
  resequenced: SEQ2.t,
  firstLand: LANDS[0]!.t,
  lastLand: LANDS[LANDS.length - 1]!.t,
};
export const RUN = run;

// ── part 1: title, agenda, roadmap ──
const openVo = 0.8;
const titleVo = openVo + d("open") + 0.6;
const agendaVo = titleVo + d("title") + 1.0;
const roadmapVo = agendaVo + d("agenda") + 0.8;
const p1End = roadmapVo + d("roadmap") + 1.2;

// ── part 2a: the problem, plain graphics ──
const fanVo = p1End + 0.6;
const cleanVo = fanVo + d("fan") + 1.2;
const lateVo = cleanVo + d("clean") + 1.6;
const stormVo = lateVo + d("late") + 1.2;
const questionVo = stormVo + d("storm") + 1.4;
const probEnd = questionVo + d("question") + 1.4;

// ── part 2b: the idea: the airport mapping and the clearances ──
const mapVo = probEnd + 0.6;
const clearVo = mapVo + d("map") + 1.0;
const ideaEnd = clearVo + d("clearances") + 1.4;

// ── the airport without a tower, then today's go-around and the rewind ──
const chaosVo = ideaEnd + 0.3;
const CHAOS = Math.max(d("chaos"), 8); // the planes' choreography, independent of how long the line is
const setupStart = chaosVo + CHAOS + 2.2;
const setupVo = setupStart + 0.3;
const todayStart = setupVo + d("setup") + 0.3;
const todayVo = todayStart + 0.1;
const todayEnd = todayVo + d("today") + 1.8; // room for B to come back down and land
const rewindEnd = todayEnd + Math.max(2.6, d("rewind") + 0.9);

// ── beat 4: the real run ──
const b4 = rewindEnd;
const real1Vo = b4 + 0.3;
const v0 = b4 + 0.8; // video time of the first push
const real2Vo = Math.max(real1Vo + d("real1") + 0.3, v0 + REAL.conflict * 0.5);
const flag = real2Vo - 0.1;
const orderVo = real2Vo + d("real2") + 0.4;
const holdVo = orderVo + d("order") + 0.4;
const fix = holdVo + d("hold") - 0.8;
const firstLand = fix + 2.4;
const landVo = firstLand - 0.3;
const lastLand = firstLand + 7; // ~1.75 s apart: the runway is clear 1.6 s after each touchdown
const b4End = Math.max(lastLand + 2.2, landVo + d("land") + 0.5);
/** Real seconds (since the first push) → video seconds, piecewise linear through the beat's anchors. */
const ANCHORS: Array<[number, number]> = [[REAL.push, v0], [REAL.conflict, flag], [REAL.settled, orderVo], [REAL.fix, fix], [REAL.firstLand, firstLand], [REAL.lastLand, lastLand]];
export function realToVideo(r: number): number {
  for (let i = 0; i + 1 < ANCHORS.length; i++) {
    const [r0, v0_] = ANCHORS[i]!, [r1, v1] = ANCHORS[i + 1]!;
    if (r <= r1 || i + 2 === ANCHORS.length) return v0_ + ((r - r0) * (v1 - v0_)) / (r1 - r0);
  }
  return v0;
}
export function videoToReal(v: number): number {
  if (v <= ANCHORS[0]![1]) return ANCHORS[0]![0] + (v - ANCHORS[0]![1]);
  for (let i = 0; i + 1 < ANCHORS.length; i++) {
    const [r0, a] = ANCHORS[i]!, [r1, b] = ANCHORS[i + 1]!;
    if (v <= b || i + 2 === ANCHORS.length) return r0 + ((v - a) * (r1 - r0)) / (b - a);
  }
  return 0;
}

// ── real agents ──
const agentsVo = b4End + 0.4;
const agentsEnd = agentsVo + d("agents") + 1.2;

// ── part 2d: how it's built ──
const b5 = agentsEnd;
const airportVo = b5 + 0.4;
const durableVo = airportVo + d("airport") + 0.5;
const sandboxVo = durableVo + d("durable") + 0.5;
const workerVo = sandboxVo + d("sandbox") + 0.5;

// ── part 3: recap, what's next, close ──
const recapStart = workerVo + d("worker") + 1.0;
const recapVo = recapStart + 0.6;
const nextVo = recapVo + d("recap") + 0.8;
const closeStart = nextVo + d("next") + 0.8;
const closeVo = closeStart + 0.4;
const end = closeVo + d("close") + 2.0;

export const T = {
  openVo, titleVo, agendaVo, roadmapVo, p1End,
  fanVo, cleanVo, lateVo, stormVo, questionVo, probEnd,
  mapVo, clearVo, ideaEnd, chaosVo, CHAOS, setupStart, setupVo, todayStart, todayVo, todayEnd, rewindEnd,
  b4, real1Vo, v0, flag, real2Vo, orderVo, holdVo, fix, firstLand, landVo, lastLand, b4End,
  agentsVo, agentsEnd, b5, airportVo, durableVo, sandboxVo, workerVo, recapStart, recapVo, nextVo, closeStart, closeVo, end,
};

export const VO: Array<{ id: LineId; at: number }> = [
  { id: "open", at: openVo }, { id: "title", at: titleVo }, { id: "agenda", at: agendaVo }, { id: "roadmap", at: roadmapVo },
  { id: "fan", at: fanVo }, { id: "clean", at: cleanVo }, { id: "late", at: lateVo }, { id: "storm", at: stormVo }, { id: "question", at: questionVo },
  { id: "map", at: mapVo }, { id: "clearances", at: clearVo }, { id: "chaos", at: chaosVo },
  { id: "setup", at: setupVo }, { id: "today", at: todayVo }, { id: "rewind", at: todayEnd + 0.5 },
  { id: "real1", at: real1Vo }, { id: "real2", at: real2Vo }, { id: "order", at: orderVo }, { id: "hold", at: holdVo }, { id: "land", at: landVo },
  { id: "agents", at: agentsVo },
  { id: "airport", at: airportVo }, { id: "durable", at: durableVo }, { id: "sandbox", at: sandboxVo }, { id: "worker", at: workerVo },
  { id: "recap", at: recapVo }, { id: "next", at: nextVo }, { id: "close", at: closeVo },
];

/** The video's sections, for the roadmap strip, and the three points with the stretch of video that shows each. */
export const SECTIONS = [
  { id: "PROBLEM", from: p1End, to: probEnd },
  { id: "IDEA", from: probEnd, to: rewindEnd },
  { id: "DEMO", from: rewindEnd, to: agentsEnd },
  { id: "HOW", from: agentsEnd, to: recapStart },
  { id: "RECAP", from: recapStart, to: closeStart },
] as const;
export const POINTS = [
  { n: 1, title: "SEE EVERY CHANGE IN FLIGHT", proof: "Every push to a fork reaches ATC within seconds" },
  { n: 2, title: "WARN ABOUT COLLISIONS EARLY", proof: "Caught one Git can't see, before anyone asked to merge" },
  { n: 3, title: "DECIDE WHAT LANDS NEXT", proof: "1 of 5 changes redid work. 0 rebases." },
] as const;
export const POINT_AT: Array<{ n: number; from: number; to: number }> = [
  { n: 1, from: b4, to: flag },
  { n: 2, from: flag, to: orderVo },
  { n: 3, from: orderVo, to: b4End },
];
export const voFile = (id: LineId) => vo[id].file;
/** Roughly when a phrase is spoken: the line's start plus its length scaled by where the phrase sits in the text. */
export function cue(id: LineId, phrase: string): number {
  const text: string = LINES[id];
  const i = text.indexOf(phrase);
  if (i < 0) throw new Error(`"${phrase}" is not in line ${id}`);
  const v = VO.find((x) => x.id === id)!;
  return v.at + (d(id) * i) / text.length;
}
export const voSeconds = d;

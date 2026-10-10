/**
 * Every time in the video, in seconds, derived from the voice-over lengths (src/data/vo.json) and the
 * recorded run (src/data/run.json). Beat 4 maps the run's real clock onto video time piecewise, so each
 * real event lands on the line that describes it; the on-screen clock always shows real time.
 */
import run from "./data/run.json";
import vo from "./data/vo.json";
import type { LineId } from "./data/script";

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

// ── beat 0: what ATC is; beats 1–3: the go-around today ──
const introVo = 0.5;
const intro2Vo = introVo + d("intro") + 0.5;
const setupStart = intro2Vo + d("intro2") + 0.8;
const setupVo = setupStart + 0.3;
const todayStart = setupVo + d("setup") + 0.3;
const todayVo = todayStart + 0.1;
const todayEnd = todayVo + d("today") + 1.8; // room for B to come back down and land
const rewindEnd = todayEnd + Math.max(2.6, d("rewind") + 0.7);

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
const lastLand = firstLand + 11;
const b4End = Math.max(lastLand + 3.8, landVo + d("land") + 0.5);
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

// ── beat 5: the airport, then the close ──
const b5 = b4End;
const airportVo = b5 + 0.4;
const durableVo = airportVo + d("airport") + 0.5;
const sandboxVo = durableVo + d("durable") + 0.5;
const closeStart = sandboxVo + d("sandbox") + 0.6;
const closeVo = closeStart + 0.4;
const end = closeVo + d("close") + 1.6;

export const T = {
  introVo, intro2Vo, setupStart, setupVo, todayStart, todayVo, todayEnd, rewindEnd,
  b4, real1Vo, v0, flag, real2Vo, orderVo, holdVo, fix, firstLand, landVo, lastLand, b4End,
  b5, airportVo, durableVo, sandboxVo, closeStart, closeVo, end,
};

export const VO: Array<{ id: LineId; at: number }> = [
  { id: "intro", at: introVo }, { id: "intro2", at: intro2Vo }, { id: "setup", at: setupVo }, { id: "today", at: todayVo }, { id: "rewind", at: todayEnd + 0.5 },
  { id: "real1", at: real1Vo }, { id: "real2", at: real2Vo }, { id: "order", at: orderVo }, { id: "hold", at: holdVo }, { id: "land", at: landVo },
  { id: "airport", at: airportVo }, { id: "durable", at: durableVo }, { id: "sandbox", at: sandboxVo }, { id: "close", at: closeVo },
];
export const voFile = (id: LineId) => vo[id].file;
export const voSeconds = d;

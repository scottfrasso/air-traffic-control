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
const pushes = run.events.filter((e) => e.kind === "push.received" && e.pr === run.b);
/** Real seconds since the first push, for the moments beat 4 shows. */
export const REAL = {
  push: 0,
  conflict: find((e) => e.kind === "check.pair" && e.detail?.status === "semantic_conflict", "semantic conflict"),
  fix: pushes[1]?.t ?? NaN,
  clean: find((e) => e.kind === "check.pair" && e.detail?.status === "clean", "clean re-check"),
  landA: find((e) => e.kind === "land.merged" && e.pr === run.a, "A landing"),
  landB: find((e) => e.kind === "land.merged" && e.pr === run.b, "B landing"),
};
const conflictEvent = run.events.find((e) => e.kind === "check.pair" && e.detail?.status === "semantic_conflict");
export const ERROR = String(conflictEvent?.detail?.errors?.[0] ?? ""); // "src/walk-in.ts:5 TS2554 Expected 3 arguments, but got 2"
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
const flag = Math.max(v0 + REAL.conflict, real1Vo + d("real1") + 0.3);
const real2Vo = flag + 0.5;
const fix = Math.max(flag + (REAL.fix - REAL.conflict), real2Vo + d("real2") + 0.3);
const real3Vo = fix + 0.1;
const landA = Math.max(fix + (REAL.landA - REAL.fix) * 0.6, real3Vo + d("real3") + 0.2);
const real4Vo = landA - 0.2;
const landB = landA + (REAL.landB - REAL.landA) * 0.6;
const b4End = Math.max(landB + 1.4, real4Vo + d("real4") + 0.4);
const clean = fix + ((landA - fix) * (REAL.clean - REAL.fix)) / (REAL.landA - REAL.fix);

/** Real seconds (since the first push) → video seconds, piecewise linear through the beat's anchors. */
const ANCHORS: Array<[number, number]> = [[REAL.push, v0], [REAL.conflict, flag], [REAL.fix, fix], [REAL.landA, landA], [REAL.landB, landB]];
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
const closeStart = airportVo + d("airport") + 0.5;
const closeVo = closeStart + 0.4;
const end = closeVo + d("close") + 1.6;

export const T = {
  introVo, intro2Vo, setupStart, setupVo, todayStart, todayVo, todayEnd, rewindEnd,
  b4, real1Vo, v0, flag, real2Vo, fix, clean, real3Vo, landA, real4Vo, landB, b4End,
  b5, airportVo, closeStart, closeVo, end,
};

export const VO: Array<{ id: LineId; at: number }> = [
  { id: "intro", at: introVo }, { id: "intro2", at: intro2Vo }, { id: "setup", at: setupVo }, { id: "today", at: todayVo }, { id: "rewind", at: todayEnd + 0.5 },
  { id: "real1", at: real1Vo }, { id: "real2", at: real2Vo }, { id: "real3", at: real3Vo }, { id: "real4", at: real4Vo },
  { id: "airport", at: airportVo }, { id: "close", at: closeVo },
];
export const voFile = (id: LineId) => vo[id].file;
export const voSeconds = d;

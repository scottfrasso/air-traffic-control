/** Logical-pixel geometry of the airport, matching the dashboard's look (worker/src/dashboard.html) at 16:9. */
export const W = 480;
export const H = 270;
export const SCALE = 4; // 480×270 logical → 1920×1080
export const GROUND = 228;
export const RUNWAY = { x: 384, w: 92, y: GROUND + 2 };
export const TOUCHDOWN = { x: RUNWAY.x + 8, y: RUNWAY.y - 3 };
export const TOWER = { x: 318, top: GROUND - 40 };
export const CHECK = { x: 344, y: GROUND - 14 }; // the check light (the Sandbox)
export const HANGARS = [26, 82, 138];
export const GATES = [352, 322, 292, 262, 232, 202];
export const GATE_Y = GROUND + 13;
export const LIVERY = { a: "#f38020", b: "#3fa2ff", c: "#ff5fb0", d: "#3ccf6e", e: "#ffd23f", f: "#a07bff" };

export interface Plane {
  id: string;
  x: number;
  y: number;
  face: 1 | -1;
  livery: string;
}

export type Pt = [number, number];

/** A point on the glide path: s = 0 is the far left edge, s = 1 is touchdown. */
const ENTRY: Pt = [-10, 74];
export function glide(s: number): Pt {
  return [ENTRY[0] + (TOUCHDOWN.x - ENTRY[0]) * s, ENTRY[1] + (TOUCHDOWN.y - ENTRY[1]) * s];
}

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const smooth = (k: number) => k * k * (3 - 2 * k);

/** Interpolate keyframes [t, x, y] with Catmull-Rom so curves (the go-around) look flown, not drawn. */
export function path(keys: Array<[number, number, number]>, t: number): { p: Pt; v: Pt } {
  const first = keys[0]!, last = keys[keys.length - 1]!;
  if (t <= first[0]) return { p: [first[1], first[2]], v: [1, 0] };
  if (t >= last[0]) {
    const prev = keys[keys.length - 2] ?? last;
    return { p: [last[1], last[2]], v: [last[1] - prev[1], last[2] - prev[2]] };
  }
  let i = 0;
  while (t > keys[i + 1]![0]) i++;
  const k0 = keys[Math.max(0, i - 1)]!, k1 = keys[i]!, k2 = keys[i + 1]!, k3 = keys[Math.min(keys.length - 1, i + 2)]!;
  const u = (t - k1[0]) / (k2[0] - k1[0]);
  const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  const p: Pt = [cr(k0[1], k1[1], k2[1], k3[1]), cr(k0[2], k1[2], k2[2], k3[2])];
  return { p, v: [k2[1] - k1[1], k2[2] - k1[2]] };
}

/**
 * A complete approach and landing: glide from s0 at t0 to touchdown at tTouch, roll out, taxi to a gate.
 * Returns where the plane is at time t (seconds, same clock as the arguments).
 */
export function landing(t: number, o: { t0: number; s0: number; tTouch: number; gate: number }): { p: Pt; face: 1 | -1; phase: "approach" | "rollout" | "taxi" | "parked" } {
  if (t < o.tTouch) {
    const s = lerp(o.s0, 1, (t - o.t0) / (o.tTouch - o.t0));
    return { p: glide(s), face: 1, phase: "approach" };
  }
  const roll = 1.3, turn = 0.3, taxi = 2.2;
  const end = RUNWAY.x + RUNWAY.w - 12;
  if (t < o.tTouch + roll) {
    const k = (t - o.tTouch) / roll;
    return { p: [lerp(TOUCHDOWN.x, end, 1 - (1 - k) * (1 - k)), TOUCHDOWN.y], face: 1, phase: "rollout" };
  }
  if (t < o.tTouch + roll + turn) return { p: [end, TOUCHDOWN.y], face: -1, phase: "taxi" };
  const k = clamp((t - o.tTouch - roll - turn) / taxi);
  if (k < 1) return { p: [lerp(end, o.gate, smooth(k)), lerp(TOUCHDOWN.y, GATE_Y, smooth(clamp(k * 3)))], face: -1, phase: "taxi" };
  return { p: [o.gate, GATE_Y], face: -1, phase: "parked" };
}

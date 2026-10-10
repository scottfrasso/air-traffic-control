import type { ForkRow } from "./types";

/**
 * Landing arbitration (prompt.md milestone 5): when two forks conflict, the one closest to landing wins;
 * ties go to the one that is cheaper to rebase (smaller diff). "Closest to landing" is ranked as:
 *   1. has requested landing
 *   2. has been checked against the current main
 *   3. is green (merged onto current main, it typechecks)
 * Returns negative if `a` should land before `b`.
 */
export function landingOrder(a: ForkRow, b: ForkRow, baselineHead: string): number {
  const score = (f: ForkRow) => [f.land_requested_at === null ? 1 : 0, f.check_base === baselineHead ? 0 : 1, isGreen(f, baselineHead) ? 0 : 1] as const;
  const [sa, sb] = [score(a), score(b)];
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
  if (a.diff_lines !== b.diff_lines) return a.diff_lines - b.diff_lines;
  return (a.land_requested_at ?? Infinity) - (b.land_requested_at ?? Infinity) || a.created_at - b.created_at;
}

/** Green = this PR's head, merged onto the current main, typechecks. */
export const isGreen = (f: ForkRow, baselineHead: string) =>
  f.check_status === "green" && f.check_sha === f.head_sha && f.processed_sha === f.head_sha && f.check_base === baselineHead;

/** Approach position for the dashboard: 0 = on the runway threshold. */
export function approachQueue(forks: ForkRow[], baselineHead: string): string[] {
  return [...forks].sort((a, b) => landingOrder(a, b, baselineHead)).map((f) => f.name);
}

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

// ── landing lock ─────────────────────────────────────────────────────────

/** Hard limit on one checker run (container side, see checker.ts). */
export const CHECK_TIMEOUT_S = 240;

/** One landing at a time per baseline. Outlives the checker's hard timeout, so a slow landing can't be overtaken. */
export const LANDING_LOCK_MS = (CHECK_TIMEOUT_S + 60) * 1000;

export type LandingLock = { token: string; at: number };

export function parseLock(raw: string | null): LandingLock | null {
  if (!raw) return null;
  try {
    const l = JSON.parse(raw) as Partial<LandingLock>;
    return typeof l.token === "string" && typeof l.at === "number" ? { token: l.token, at: l.at } : null;
  } catch {
    return null; // legacy "<timestamp>" value or garbage: treat as free
  }
}

/** Take the lock if it is free or expired; returns the new lock, or null if someone else holds it. */
export function takeLock(current: LandingLock | null, now: number, token: string, ttl = LANDING_LOCK_MS): LandingLock | null {
  if (current && current.at > now - ttl) return null;
  return { token, at: now };
}

/** Only the holder may release: a landing whose lock expired and was taken over must not clear the new owner's. */
export const mayRelease = (current: LandingLock | null, token: string) => current?.token === token;

// ── pair coverage ────────────────────────────────────────────────────────

export type PairCheckRow = { fork_a: string; fork_b: string; sha_a: string; sha_b: string };
export type PairNeed = { a: string; b: string; shaA: string; shaB: string };

/**
 * Every pair of active PRs with pushed changes must have a speculative-merge result for their CURRENT heads.
 * Returns the pairs that don't (never checked, or checked at older heads). Names are sorted: a < b.
 */
export function outstandingPairs(forks: ForkRow[], checks: PairCheckRow[]): PairNeed[] {
  const live = forks.filter((f) => f.status === "active" && f.head_sha !== f.base_sha).sort((x, y) => (x.name < y.name ? -1 : 1));
  const done = new Set(checks.map((c) => `${c.fork_a}|${c.fork_b}|${c.sha_a}|${c.sha_b}`));
  const out: PairNeed[] = [];
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const [a, b] = [live[i]!, live[j]!];
      if (!done.has(`${a.name}|${b.name}|${a.head_sha}|${b.head_sha}`)) out.push({ a: a.name, b: b.name, shaA: a.head_sha, shaB: b.head_sha });
    }
  return out;
}

/** Forks with at least one outstanding pair: they can't be cleared or land yet. */
export const forksWaitingOnPairs = (needs: PairNeed[]) => new Set(needs.flatMap((n) => [n.a, n.b]));

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
export type PairQueueRow = PairCheckRow & { queued_at: number };
export type PairNeed = { a: string; b: string; shaA: string; shaB: string };

/** A queued pair check with no result after this long is assumed lost and queued again. */
export const PAIR_RETRY_MS = LANDING_LOCK_MS;

/**
 * Every pair of active PRs with pushed changes must have a speculative-merge result for their CURRENT heads.
 * Returns the pairs that don't (never checked, or checked at older heads). Names are sorted: a < b.
 * PRs whose latest push isn't indexed yet are left out: they can't land anyway, and their push pipeline
 * queues their pairs, so a PR stuck there must not block the PRs it pairs with.
 */
export function outstandingPairs(forks: ForkRow[], checks: PairCheckRow[]): PairNeed[] {
  const ready = forks.filter(needsPairChecks).sort((x, y) => (x.name < y.name ? -1 : 1)); // same order as pair_checks rows
  const done = new Set(checks.map((c) => pairKey(c.fork_a, c.fork_b, c.sha_a, c.sha_b)));
  return ready
    .flatMap((a, i) => ready.slice(i + 1).map((b) => ({ a: a.name, b: b.name, shaA: a.head_sha, shaB: b.head_sha })))
    .filter((p) => !done.has(pairKey(p.a, p.b, p.shaA, p.shaB)));
}

const needsPairChecks = (f: ForkRow) => f.status === "active" && f.head_sha !== f.base_sha && f.processed_sha === f.head_sha;
const pairKey = (a: string, b: string, shaA: string, shaB: string) => `${a}|${b}|${shaA}|${shaB}`;

/** Forks with at least one outstanding pair: they can't be cleared or land yet. */
export const forksWaitingOnPairs = (needs: PairNeed[]) => new Set(needs.flatMap((n) => [n.a, n.b]));

/**
 * A pair result may be recorded only if it is for both PRs' CURRENT heads. An older result (a slow check from an
 * earlier push) would overwrite a newer one; a result for a push ATC hasn't seen yet would count as checked
 * without its conflicts ever being raised. Both get dropped and the pair is re-queued instead.
 */
export function pairResultIsCurrent(forks: ForkRow[], a: string, shaA: string, b: string, shaB: string): boolean {
  const head = (n: string) => forks.find((f) => f.name === n && f.status === "active")?.head_sha;
  return head(a) === shaA && head(b) === shaB;
}

/** Outstanding pairs that aren't already queued at the same heads within the retry window. */
export function pairsToQueue(needs: PairNeed[], queue: PairQueueRow[], now: number, retryMs = PAIR_RETRY_MS): PairNeed[] {
  const q = new Map(queue.map((r) => [`${r.fork_a}|${r.fork_b}`, r]));
  return needs.filter((n) => {
    const r = q.get(`${n.a}|${n.b}`);
    return !(r && r.sha_a === n.shaA && r.sha_b === n.shaB && r.queued_at > now - retryMs);
  });
}

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

// ── landing gate ─────────────────────────────────────────────────────────

export type GateInput = {
  me: ForkRow;
  baselineHead: string;
  /** Why this PR must go around (it conflicts with something that already landed), if it must. */
  goAround?: string;
  /** Some pair check against another PR's current head isn't in yet. */
  waitingOnPairs: boolean;
  /** Active PRs with an open conflict against this one. */
  rivals: ForkRow[];
};

export type Gate =
  | { kind: "land" }
  /** Ask again shortly. `then`: what ATC starts first (a re-check on the new main, or the missing pair checks). */
  | { kind: "retry"; reason: string; then?: "recheck" | "requeue_pairs" }
  /** Refused. `signal`: the signal to send the PR (none for a go-around, which already has its own). */
  | { kind: "deny"; reason: string; signal: "rebase_required" | "land_blocked" | null };

/** May this PR land now? The checks run in this order; the first that fails decides (ADR-0011, issues #3 and #5). */
export function landGate({ me, baselineHead, goAround, waitingOnPairs, rivals }: GateInput): Gate {
  if (goAround) return { kind: "deny", reason: goAround, signal: null };
  if (me.processed_sha !== me.head_sha || me.check_sha !== me.head_sha || me.check_status === "pending")
    return { kind: "retry", reason: "Checks for your latest push are still running; retry in a few seconds." };
  // Main moved since this PR was checked: re-verify on the new main (merge queue — no rebase needed).
  if (me.check_base !== baselineHead) return { kind: "retry", reason: "Main moved; re-checking your PR on the new main. Retry in a few seconds.", then: "recheck" };
  if (!isGreen(me, baselineHead)) {
    const detail = me.check_detail ?? "";
    return detail.startsWith("on main:")
      ? { kind: "deny", reason: `Your PR doesn't fit on current main: ${detail.slice(9)}. Rebase onto main and fix.`, signal: "rebase_required" }
      : { kind: "deny", reason: `Your PR does not typecheck at ${me.head_sha.slice(0, 7)}: ${detail}`.trim(), signal: "land_blocked" };
  }
  // Never land before every pair check against the other PRs' current heads is in (issue #5).
  if (waitingOnPairs) return { kind: "retry", reason: "Still checking your PR against the other open PRs; retry in a few seconds.", then: "requeue_pairs" };
  const r = rivals.find((x) => landingOrder(x, me, baselineHead) < 0);
  if (r)
    return {
      kind: "deny",
      reason: `${r.name} conflicts with your fork and is closer to landing (it ${r.land_requested_at ? "already requested landing" : "is ahead"}${r.diff_lines < me.diff_lines ? " and has a smaller diff" : ""}). Wait for it to land, then rebase.`,
      signal: "land_blocked",
    };
  return { kind: "land" };
}

// ── pair coverage ────────────────────────────────────────────────────────

export type PairCheckRow = { fork_a: string; fork_b: string; sha_a: string; sha_b: string; status?: string; detail?: string; checked_at?: number };
export type PairQueueRow = PairCheckRow & { queued_at: number };
/** `failedAt`: the last attempt at these heads ended in an error; it is retried once PAIR_ERROR_RETRY_MS has passed. */
export type PairNeed = { a: string; b: string; shaA: string; shaB: string; failedAt?: number };

/** A queued pair check with no result after this long is assumed lost and queued again. */
export const PAIR_RETRY_MS = LANDING_LOCK_MS;
/** A pair check that ends in an error (after its own step retries) is run again, up to this many times in all. */
export const PAIR_MAX_ATTEMPTS = 3;
/** Wait this long after an errored attempt before the next one (the reconcile alarm picks it up). */
export const PAIR_ERROR_RETRY_MS = 30_000;

/**
 * How many attempts at these heads have ended in an error. An "error" row without a count was written before
 * retries existed: treat it as final, as it was then.
 */
export function pairAttempts(c: PairCheckRow): number {
  if (c.status !== "error") return 0;
  try {
    const n = (JSON.parse(c.detail ?? "{}") as { attempts?: unknown }).attempts;
    return typeof n === "number" ? n : PAIR_MAX_ATTEMPTS;
  } catch {
    return PAIR_MAX_ATTEMPTS;
  }
}

/** A real result, or an error that has used up its retries (so a broken checker can't block landing forever). */
const pairIsFinal = (c: PairCheckRow) => c.status !== "error" || pairAttempts(c) >= PAIR_MAX_ATTEMPTS;

/**
 * Every pair of active PRs with pushed changes must have a speculative-merge result for their CURRENT heads.
 * Returns the pairs that don't (never checked, checked at older heads, or errored with retries left).
 * Names are sorted: a < b. A PR whose latest push is still being indexed counts too: its partners wait for that pair.
 */
export function outstandingPairs(forks: ForkRow[], checks: PairCheckRow[]): PairNeed[] {
  const ready = forks.filter(needsPairChecks).sort((x, y) => (x.name < y.name ? -1 : 1)); // same order as pair_checks rows
  const byKey = new Map(checks.map((c) => [pairKey(c.fork_a, c.fork_b, c.sha_a, c.sha_b), c]));
  return ready
    .flatMap((a, i) => ready.slice(i + 1).map((b) => ({ a: a.name, b: b.name, shaA: a.head_sha, shaB: b.head_sha })))
    .flatMap((p): PairNeed[] => {
      const c = byKey.get(pairKey(p.a, p.b, p.shaA, p.shaB));
      if (!c) return [p];
      if (pairIsFinal(c)) return [];
      return [{ ...p, failedAt: c.checked_at ?? 0 }];
    });
}

const needsPairChecks = (f: ForkRow) => f.status === "active" && f.head_sha !== f.base_sha;
const pairKey = (a: string, b: string, shaA: string, shaB: string) => `${a}|${b}|${shaA}|${shaB}`;

/** Forks with at least one outstanding pair: they can't be cleared or land yet. */
export const forksWaitingOnPairs = (needs: PairNeed[]) => new Set(needs.flatMap((n) => [n.a, n.b]));

/** A fresh push's pipeline checks it against every other active PR with pushed changes (null: superseded). */
export function pairPartners(forks: ForkRow[], fork: string, sha: string): ForkRow[] | null {
  const me = forks.find((f) => f.name === fork);
  if (!me || me.status !== "active" || me.head_sha !== sha) return null;
  return forks.filter((f) => f.name !== fork && f.status === "active" && f.head_sha !== f.base_sha);
}

/** The pair_queue row for checking x and y at their current heads (names sorted). */
export function queuedPair(x: ForkRow, y: ForkRow, now: number): PairQueueRow {
  const [a, b] = x.name < y.name ? [x, y] : [y, x];
  return { fork_a: a.name, fork_b: b.name, sha_a: a.head_sha, sha_b: b.head_sha, queued_at: now };
}

/**
 * A pair result may be recorded only if it is for both PRs' CURRENT heads. An older result (a slow check from an
 * earlier push) would overwrite a newer one; a result for a push ATC hasn't seen yet would count as checked
 * without its conflicts ever being raised. Both get dropped and the pair is re-queued instead.
 */
export function pairResultIsCurrent(forks: ForkRow[], a: string, shaA: string, b: string, shaB: string): boolean {
  const head = (n: string) => forks.find((f) => f.name === n && f.status === "active")?.head_sha;
  return head(a) === shaA && head(b) === shaB;
}

/** The pair_checks row for a finished check (names sorted), or null if it isn't for both current heads. */
export function pairResultRow(forks: ForkRow[], a: string, shaA: string, b: string, shaB: string, status: string, detail: string, now: number): PairCheckRow | null {
  if (!pairResultIsCurrent(forks, a, shaA, b, shaB)) return null;
  const [x, sx, y, sy] = a < b ? [a, shaA, b, shaB] : [b, shaB, a, shaA];
  return { fork_a: x, fork_b: y, sha_a: sx, sha_b: sy, status, detail, checked_at: now };
}

/**
 * Outstanding pairs to start now: not already in flight at the same heads (queued within the retry window, and no
 * error recorded since), past the back-off after an errored attempt, and with neither PR still being indexed
 * (`indexing`: fork → when its unindexed head was seen; its push pipeline queues those pairs).
 * A PR stuck in indexing past the retry window gets its pairs checked directly, so it can't block its partners forever.
 */
export function pairsToQueue(
  needs: PairNeed[], queue: PairQueueRow[], now: number, indexing = new Map<string, number>(), retryMs = PAIR_RETRY_MS, errorRetryMs = PAIR_ERROR_RETRY_MS,
): PairNeed[] {
  const q = new Map(queue.map((r) => [`${r.fork_a}|${r.fork_b}`, r]));
  const recent = (at: number | undefined) => at !== undefined && at > now - retryMs;
  return needs.filter((n) => {
    const r = q.get(`${n.a}|${n.b}`);
    const finished = n.failedAt !== undefined && r !== undefined && n.failedAt >= r.queued_at; // that run ended in an error
    if (r && r.sha_a === n.shaA && r.sha_b === n.shaB && recent(r.queued_at) && !finished) return false;
    if (n.failedAt !== undefined && now < n.failedAt + errorRetryMs) return false;
    return !recent(indexing.get(n.a)) && !recent(indexing.get(n.b));
  });
}

export type PairFailure =
  | { record: false; why: "stale" | "has_result" }
  /** Record `row` (status "error"). `final`: retries are used up, so the pair counts as checked and both PRs are told. */
  | { record: true; row: PairCheckRow; attempts: number; final: boolean };

/**
 * A pair check that still failed after its step retries. It is recorded as an error with an attempt count, and stays
 * outstanding (so neither PR is cleared) until PAIR_MAX_ATTEMPTS attempts have failed. Dropped if the heads moved
 * (a newer push re-queues it) or if a real result already exists at the same heads (a slow duplicate run failed).
 */
export function pairFailure(forks: ForkRow[], checks: PairCheckRow[], a: string, shaA: string, b: string, shaB: string, error: string, now: number): PairFailure {
  if (!pairResultIsCurrent(forks, a, shaA, b, shaB)) return { record: false, why: "stale" };
  const [x, sx, y, sy] = a < b ? [a, shaA, b, shaB] : [b, shaB, a, shaA];
  const prev = checks.find((c) => c.fork_a === x && c.fork_b === y && c.sha_a === sx && c.sha_b === sy);
  if (prev && prev.status !== "error") return { record: false, why: "has_result" };
  const attempts = (prev ? pairAttempts(prev) : 0) + 1;
  const row = { fork_a: x, fork_b: y, sha_a: sx, sha_b: sy, status: "error", detail: JSON.stringify({ error: error.slice(0, 500), attempts }), checked_at: now };
  return { record: true, row, attempts, final: attempts >= PAIR_MAX_ATTEMPTS };
}

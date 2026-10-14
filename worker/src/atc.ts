import { checkDetail, checkErrored, isGreen, landingOrder, mainConflict } from "./landing";
import type { ForkRow } from "./types";

/**
 * Air Traffic Control: the landing sequence. One row per in-flight PR with a clearance and ONE short reason,
 * the way a controller would say it. Agents read their own row through `get_clearance`; the dashboard shows all rows.
 */

export type Clearance = "cleared" | "follow" | "hold" | "go_around" | "checking" | "fix" | "review";

export interface SequenceEntry {
  fork: string;
  pr: string;
  position: number;
  clearance: Clearance;
  reason: string;
  /** Fork this one is waiting on, if any. */
  behind: string | null;
}

export interface Conflict {
  other: string;
  symbol: string | null;
}

/** "shop-123--pr4" → "PR4". Falls back to the agent part for older fork names. */
export function prLabel(fork: string): string {
  const m = /--pr(\d+)$/.exec(fork);
  return m ? `PR${m[1]}` : (fork.split("--").slice(1).join("--") || fork).toUpperCase();
}

/**
 * `goAround`: PRs that must rebase because they conflict with something that already landed (fork → short reason).
 * Everyone else stays in line: ATC lands them by merging onto main (merge queue), so they never rebase just because main moved.
 * `pairsPending`: PRs still missing a speculative-merge result against another PR's current head; never cleared until it's in.
 */
export function buildSequence(
  forks: ForkRow[],
  conflicts: Map<string, Conflict[]>,
  baselineHead: string,
  goAround: Map<string, string> = new Map(),
  pairsPending: Set<string> = new Set(),
  /** PRs whose checks ATC stopped restarting (after CHECK_MAX_RESTARTS): only a new push retries them. */
  checksGaveUp: Set<string> = new Set(),
  /** Review gate (issue #16): PRs that would be cleared or follow but aren't approved at their head, and why. */
  review: Map<string, string> = new Map(),
): SequenceEntry[] {
  const active = forks.filter((f) => f.status === "active").sort((a, b) => landingOrder(a, b, baselineHead));
  const byName = new Map(active.map((f) => [f.name, f]));
  const out: SequenceEntry[] = [];
  let leader: string | null = null;
  let position = 0;

  for (const f of active) {
    const pr = prLabel(f.name);
    const mine = (conflicts.get(f.name) ?? []).filter((c) => byName.has(c.other));
    const on = (c: Conflict) => (c.symbol ? ` on ${c.symbol}` : "");
    const entry = (clearance: Clearance, reason: string, behind: string | null = null) => out.push({ fork: f.name, pr, position: ++position, clearance, reason, behind });

    if (f.head_sha === f.base_sha) {
      entry("checking", "No changes pushed yet.");
      continue;
    }
    if (goAround.has(f.name)) {
      entry("go_around", goAround.get(f.name)!);
      continue;
    }
    if (checkErrored(f)) {
      const why = f.check_detail ? firstLine(f.check_detail) : "unknown error";
      entry("checking", `ATC couldn't run the checks (${why}). ${checksGaveUp.has(f.name) ? "Push again to retry." : "ATC tries again by itself a few times, or push again."}`);
      continue;
    }
    if (f.processed_sha !== f.head_sha || f.check_sha !== f.head_sha) {
      entry("checking", "Checks running.");
      continue;
    }
    if (f.check_status === "pending" || f.check_base !== baselineHead) {
      entry("checking", "Main moved. Re-checking against the new main.");
      continue;
    }
    if (!isGreen(f, baselineHead)) {
      const detail = firstLine(checkDetail(f));
      if (mainConflict(f)) entry("go_around", `Doesn't fit on current main (${detail}). Rebase and fix.`);
      else entry("fix", `Fails typecheck${detail ? `: ${detail}` : ""}.`);
      continue;
    }
    if (pairsPending.has(f.name)) {
      entry("checking", "Checking against the other PRs.");
      continue;
    }
    // A conflicting PR that is ahead in the order lands first; this one holds.
    const ahead = mine.find((c) => landingOrder(byName.get(c.other)!, f, baselineHead) < 0);
    if (ahead) {
      // Not "then rebase": fixing the conflict while holding avoids the go-around, which is the point (issue #6).
      entry("hold", `Conflicts with ${prLabel(ahead.other)}${on(ahead)}. Lands after ${prLabel(ahead.other)}. Fix it now to avoid a go-around.`, ahead.other);
      continue;
    }
    // Fit to land, but not approved: it waits in REVIEW and doesn't hold up the PRs behind it.
    if (review.has(f.name)) {
      entry("review", review.get(f.name)!);
      continue;
    }
    if (!leader) {
      leader = f.name;
      const beat = mine[0];
      const why = f.land_requested_at !== null ? "requested landing first" : "smaller diff";
      entry("cleared", beat ? `Cleared to land. Beats ${prLabel(beat.other)}${on(beat)}: ${why}.` : "Cleared to land. No conflicts.");
      continue;
    }
    // Its only conflicts are with PRs behind it (one ahead would have made it hold): they wait for it.
    // One name per PR: a pair can have several open conflict signals (different symbols, files or errors).
    const behind = [...new Set(mine.map((c) => prLabel(c.other)))];
    entry("follow", `Follow ${prLabel(leader)}. ${behind.length ? `${behind.join(", ")} will wait for you.` : "No conflicts."}`, leader);
  }
  return out;
}

/** What ATC tells one agent. */
export function clearanceMessage(e: SequenceEntry): string {
  const words: Record<Clearance, string> = { cleared: "cleared to land", follow: "number " + e.position, hold: "hold", go_around: "go around", checking: "standby", fix: "hold", review: "waiting for review" };
  return `ATC: ${e.pr}, ${words[e.clearance]}. ${e.reason}`;
}

const firstLine = (s: string) => (s.split("\n")[0] ?? "").slice(0, 80);

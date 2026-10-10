import { isGreen, landingOrder } from "./landing";
import type { ForkRow } from "./types";

/**
 * Air Traffic Control: the landing sequence. One row per in-flight PR with a clearance and ONE short reason,
 * the way a controller would say it. Agents read their own row through `get_clearance`; the dashboard shows all rows.
 */

export type Clearance = "cleared" | "follow" | "hold" | "go_around" | "checking" | "fix";

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

export function buildSequence(forks: ForkRow[], conflicts: Map<string, Conflict[]>, baselineHead: string): SequenceEntry[] {
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
    if (f.processed_sha !== f.head_sha || f.check_status === "pending" || f.check_sha !== f.head_sha) {
      entry("checking", "Checks running.");
      continue;
    }
    if (f.base_sha !== baselineHead) {
      entry("go_around", "Baseline moved. Rebase, then rejoin.");
      continue;
    }
    if (!isGreen(f)) {
      entry("fix", `Fails typecheck${f.check_detail ? `: ${firstLine(f.check_detail)}` : ""}.`);
      continue;
    }
    // A conflicting PR that is ahead in the order lands first; this one holds.
    const ahead = mine.find((c) => landingOrder(byName.get(c.other)!, f, baselineHead) < 0);
    if (ahead) {
      entry("hold", `Conflicts with ${prLabel(ahead.other)}${on(ahead)}. Lands after ${prLabel(ahead.other)}, then rebase.`, ahead.other);
      continue;
    }
    if (!leader) {
      leader = f.name;
      const beat = mine[0];
      const why = f.land_requested_at !== null ? "requested landing first" : "smaller diff";
      entry("cleared", beat ? `Cleared to land. Beats ${prLabel(beat.other)}${on(beat)}: ${why}.` : "Cleared to land. No conflicts.");
      continue;
    }
    entry("follow", `Follow ${prLabel(leader)}. No conflicts; rebase after it lands.`, leader);
  }
  return out;
}

/** What ATC tells one agent. */
export function clearanceMessage(e: SequenceEntry): string {
  const words: Record<Clearance, string> = { cleared: "cleared to land", follow: "number " + e.position, hold: "hold", go_around: "go around", checking: "standby", fix: "hold" };
  return `ATC: ${e.pr}, ${words[e.clearance]}. ${e.reason}`;
}

const firstLine = (s: string) => (s.split("\n")[0] ?? "").slice(0, 80);

import { prLabel } from "./atc";

/**
 * A PR's flight log (issue #15, ADR-0019): why it looks the way it does when it lands. ATC writes it as a git note
 * under refs/notes/atc on the landed commit, so `git log --notes=atc` on main tells each PR's story.
 * Every line after the title is a `Key: value` trailer, so `git interpret-trailers --parse` reads it too.
 */

export type FlightSignal = { kind: string; about_fork: string | null; symbol: string | null; message: string; created_at: number };
export type ClearanceStep = { at: number; clearance: string; reason: string };
export type SequenceSnapshot = { at: number; sequence: Array<{ fork: string; clearance: string; reason: string }> };

export interface FlightLogInput {
  fork: string;
  agent: string;
  diffLines: number;
  intents: string[];
  signals: FlightSignal[];
  clearances: ClearanceStep[];
  /** Main commit the PR lands onto. */
  onto: string;
}

const WORD: Record<string, string> = { cleared: "CLEARED", follow: "FOLLOW", hold: "HOLD", go_around: "GO AROUND", checking: "STANDBY", fix: "HOLD" };

/** Signal kinds worth keeping: what other work this PR ran into. Go-arounds get their own trailer. */
const STORY_KINDS = new Set(["semantic_conflict", "merge_conflict", "signature_change", "intent_overlap", "overlap", "check_failed"]);

/** One clearance per change of clearance, from the recorded sequence snapshots (oldest first). */
export function clearanceHistory(snapshots: SequenceSnapshot[], fork: string): ClearanceStep[] {
  const out: ClearanceStep[] = [];
  for (const s of snapshots) {
    const e = s.sequence.find((x) => x.fork === fork);
    if (!e || out.at(-1)?.clearance === e.clearance) continue;
    out.push({ at: s.at, clearance: e.clearance, reason: e.reason });
  }
  return out;
}

const oneLine = (s: string, max = 200) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};
const about = (s: FlightSignal) => `${s.about_fork ? ` with ${prLabel(s.about_fork)}` : ""}${s.symbol ? ` on ${s.symbol}` : ""}`;

/** The note text ATC attaches to the landed commit. */
export function flightLogNote(f: FlightLogInput): string {
  const pr = prLabel(f.fork);
  const lines = [`ATC flight log: ${pr} (agent ${oneLine(f.agent, 40)})`, "", `ATC-PR: ${pr}`, `ATC-Agent: ${oneLine(f.agent)}`];
  // Latest distinct intents only: an agent re-declaring in a loop must not grow the note without bound.
  for (const i of [...new Set(f.intents.map((x) => oneLine(x)))].slice(-3)) lines.push(`ATC-Intent: ${i}`);
  const seen = new Set<string>();
  for (const s of [...f.signals].sort((a, b) => a.created_at - b.created_at)) {
    if (!STORY_KINDS.has(s.kind)) continue;
    const line = `ATC-Signal: ${s.kind}${about(s)}`;
    if (!seen.has(line)) (seen.add(line), lines.push(line));
  }
  // The capped list keeps the first steps and the last ones: how it started and how it got cleared.
  const steps = f.clearances.length > 8 ? [...f.clearances.slice(0, 3), ...f.clearances.slice(-5)] : f.clearances;
  for (const c of steps) lines.push(`ATC-Clearance: ${WORD[c.clearance] ?? c.clearance.toUpperCase()} (${oneLine(c.reason, 160)})`);
  for (const s of f.signals.filter((x) => x.kind === "rebase_required").sort((a, b) => a.created_at - b.created_at))
    lines.push(`ATC-Go-Around: ${s.about_fork ? `sent around after ${prLabel(s.about_fork)} landed (conflict${s.symbol ? ` on ${s.symbol}` : ""}); landed after a new push` : oneLine(s.message)}`);
  lines.push(`ATC-Diff-Lines: ${f.diffLines}`, `ATC-Landed-Onto: ${f.onto.slice(0, 12)}`);
  return lines.join("\n");
}

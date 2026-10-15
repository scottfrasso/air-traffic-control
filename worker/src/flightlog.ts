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
  /** Main commit the PR lands onto (or current main, while in flight). */
  onto: string;
  /** False for an in-flight PR's log so far: it must not claim a landing. */
  landed: boolean;
  /** The approval it landed with, when the review gate is on (issue #16). */
  review?: { verdict: string; reviewer: string; note: string };
  /** Other attempts at the same task this PR was chosen over, each with why (issue #19). */
  chosenOver?: string[];
}

const WORD: Record<string, string> = { cleared: "CLEARED", follow: "FOLLOW", hold: "HOLD", go_around: "GO AROUND", checking: "STANDBY", fix: "HOLD", review: "REVIEW", stand_down: "STAND DOWN" };

/** Signal kinds worth keeping: what other work this PR ran into. Go-arounds get their own trailer. */
const STORY_KINDS = new Set(["semantic_conflict", "merge_conflict", "signature_change", "intent_overlap", "overlap", "check_failed", "stand_down"]);

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

const MAX_SIGNALS = 12;

// Control characters (and bidi overrides, which can make a line read differently from what it says) become spaces.
const CONTROL = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const oneLine = (s: string, max = 200) => {
  const t = s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};
// Symbols can come from agents (declared intents): keep them on one line so they can't forge a trailer.
const about = (s: FlightSignal) => `${s.about_fork ? ` with ${oneLine(prLabel(s.about_fork), 80)}` : ""}${s.symbol ? ` on ${oneLine(s.symbol, 80)}` : ""}`;

/** The note text ATC attaches to the landed commit. */
export function flightLogNote(f: FlightLogInput): string {
  const pr = prLabel(f.fork);
  const lines = [`ATC flight log: ${pr} (agent ${oneLine(f.agent, 40)})`, "", `ATC-PR: ${pr}`, `ATC-Agent: ${oneLine(f.agent)}`];
  // Latest distinct intents only: an agent re-declaring in a loop must not grow the note without bound.
  for (const i of [...new Set(f.intents.map((x) => oneLine(x)).filter(Boolean).reverse())].slice(0, 3).reverse()) lines.push(`ATC-Intent: ${i}`);
  const signalLines = [...new Set([...f.signals].sort((a, b) => a.created_at - b.created_at).filter((s) => STORY_KINDS.has(s.kind)).map((s) => `ATC-Signal: ${s.kind}${about(s)}`))];
  lines.push(...signalLines.slice(0, MAX_SIGNALS));
  if (signalLines.length > MAX_SIGNALS) lines.push(`ATC-Signal: ... and ${signalLines.length - MAX_SIGNALS} more`);
  // The capped list keeps the first steps and the last ones: how it started and how it got cleared.
  const steps = f.clearances.length > 8 ? [...f.clearances.slice(0, 3), ...f.clearances.slice(-5)] : f.clearances;
  for (const c of steps) lines.push(`ATC-Clearance: ${WORD[c.clearance] ?? c.clearance.toUpperCase()} (${oneLine(c.reason, 160)})`);
  for (const s of f.signals.filter((x) => x.kind === "rebase_required").sort((a, b) => a.created_at - b.created_at).slice(-3))
    lines.push(`ATC-Go-Around: ${s.about_fork ? `sent around after ${oneLine(prLabel(s.about_fork), 80)} landed (conflict${s.symbol ? ` on ${oneLine(s.symbol, 80)}` : ""})${f.landed ? "; landed after a new push" : ""}` : oneLine(s.message)}`);
  for (const c of (f.chosenOver ?? []).slice(0, 3)) lines.push(`ATC-Chosen-Over: ${oneLine(c, 240)}`);
  if (f.review) lines.push(`ATC-Review: ${f.review.verdict === "approve" ? "approved" : "changes requested"} by ${oneLine(f.review.reviewer, 60)}${f.review.note ? ` (${oneLine(f.review.note, 160)})` : ""}`);
  lines.push(`ATC-Diff-Lines: ${f.diffLines}`, f.landed ? `ATC-Landed-Onto: ${f.onto.slice(0, 12)}` : `ATC-In-Flight-On: ${f.onto.slice(0, 12)}`);
  // git strips trailing whitespace from notes; do the same so ATC's copy and git's stay identical (idempotent retries).
  return lines.map((l) => l.trimEnd()).join("\n");
}

/** The fallback note if building the full one fails: who landed, onto what. A landing never waits on a good story. */
export function minimalFlightLog(fork: string, agent: string, onto: string): string {
  const pr = prLabel(fork);
  return [`ATC flight log: ${pr} (agent ${oneLine(agent, 40)})`, "", `ATC-PR: ${pr}`, `ATC-Agent: ${oneLine(agent)}`, `ATC-Landed-Onto: ${onto.slice(0, 12)}`]
    .map((l) => l.trimEnd())
    .join("\n");
}

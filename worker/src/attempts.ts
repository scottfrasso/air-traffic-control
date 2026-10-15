import { prLabel } from "./atc";
import { isGreen } from "./landing";
import type { ForkRow } from "./types";

/**
 * Competing attempts at the same task (issue #19, ADR-0026). Agents name the task they're on in `declare_intent`
 * (`task`); PRs whose latest intent names the same task are attempts at it. Both keep flying until both are checked,
 * then ATC compares them: one ships, the others are told to STAND DOWN and why. A person can override the pick.
 */

/** One attempt, with what the comparison needs from the index. */
export type Attempt = {
  fork: ForkRow;
  task: string;
  /** Exported symbols this PR changes in a breaking way (signature changed or removed). */
  breaking: number;
  /** Exported symbols this PR adds, changes or removes. */
  symbols: number;
  files: number;
  /** Open conflicts with in-flight PRs that are NOT attempts at the same task. */
  conflicts: number;
  /** Set by attemptVerdicts: green on current main, pairs in, not sent around. */
  green?: boolean;
};

/** What ATC says to one attempt. */
export type AttemptVerdict =
  /** It doesn't ship: `winner` does. `final`: the winner already landed, so nothing this PR does changes that. */
  | { kind: "stand_down"; winner: string; reason: string; final: boolean }
  /** It's ahead, but another attempt is still being checked: wait for it, so the comparison is fair. */
  | { kind: "wait"; reason: string; on: string[] }
  /** It ships. `over`: the attempts it beat and why (for its flight log). */
  | { kind: "chosen"; over: Array<{ fork: string; reason: string }> };

/** A person's pick for a task (table `task_choices`). */
export type TaskChoice = { task: string; winner: string; by: string; at: number };

/** Task keys are compared trimmed and case-insensitive; null for none. */
export function normalizeTask(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 100);
  return t || null;
}

/**
 * Checked on current main, with every pair check in: green, red or (for good) errored. Until then the comparison
 * waits for it, so an attempt that's merely slower to check doesn't lose. A PR sent around (`goAround`) is decided
 * too: ATC doesn't re-check it until it pushes, so waiting for it could take forever.
 */
export function decided(f: ForkRow, baselineHead: string, pairsPending: Set<string>, goAround: Set<string> = new Set()): boolean {
  if (goAround.has(f.name)) return true;
  if (f.check_sha !== f.head_sha || f.processed_sha !== f.head_sha) return false;
  if (f.check_status === "error") return true;
  if (f.check_status !== "green" && f.check_status !== "red") return false;
  return f.check_base === baselineHead && !pairsPending.has(f.name);
}

type Step = { name: string; score: (a: Attempt) => number; says: (w: Attempt, l: Attempt) => string };

const STEPS: Step[] = [
  { name: "green", score: (a) => (a.green ?? a.fork.check_status === "green" ? 0 : 1), says: () => "it is green on current main and yours isn't" },
  { name: "conflicts", score: (a) => a.conflicts, says: (w, l) => `fewer conflicts with other in-flight PRs (${w.conflicts} vs ${l.conflicts})` },
  { name: "breaking", score: (a) => a.breaking, says: (w, l) => `smaller blast radius (${w.breaking} vs ${l.breaking} breaking changes to exported symbols)` },
  { name: "symbols", score: (a) => a.symbols, says: (w, l) => `smaller blast radius (${w.symbols} vs ${l.symbols} exported symbols changed)` },
  { name: "files", score: (a) => a.files, says: (w, l) => `fewer files touched (${w.files} vs ${l.files})` },
  { name: "diff", score: (a) => a.fork.diff_lines, says: (w, l) => `smaller diff (${w.fork.diff_lines} vs ${l.fork.diff_lines} lines)` },
  { name: "earlier", score: (a) => a.fork.created_at, says: () => "same size; it was opened first" },
];

/**
 * Which of two decided attempts ships. Ranked in order: green on current main, fewer conflicts with other in-flight
 * PRs, fewer breaking changes to exported symbols, fewer exported symbols changed, fewer files, smaller diff, earlier.
 * The first step that differs decides, and is the reason given.
 */
export function compareAttempts(a: Attempt, b: Attempt): { winner: Attempt; loser: Attempt; step: string; reason: string } {
  for (const s of STEPS) {
    const [sa, sb] = [s.score(a), s.score(b)];
    if (sa === sb) continue;
    const [winner, loser] = sa < sb ? [a, b] : [b, a];
    return { winner, loser, step: s.name, reason: s.says(winner, loser) };
  }
  const [winner, loser] = a.fork.name < b.fork.name ? [a, b] : [b, a];
  return { winner, loser, step: "name", reason: "same size; it was opened first" };
}

const isGreenNow = (f: ForkRow, head: string, pairsPending: Set<string>, goAround = new Set<string>()) => isGreen(f, head) && !pairsPending.has(f.name) && !goAround.has(f.name);

/**
 * ATC's verdict for every attempt that has one. Per task:
 *  - an attempt at it already landed: the others stand down (final);
 *  - a person picked one (and it's still in flight): that one ships, the rest stand down;
 *  - otherwise, while any attempt is still being checked, the decided green ones wait for it;
 *  - once all are decided, the best (compareAttempts) ships if it is green; the rest stand down.
 * Attempts without pushed changes don't count: an agent that never pushes can't hold up the other.
 */
export function attemptVerdicts(
  attempts: Attempt[],
  /** Landed PRs and the task their latest intent named. */
  landed: Array<{ fork: string; task: string }>,
  baselineHead: string,
  pairsPending: Set<string> = new Set(),
  choices: TaskChoice[] = [],
  /** PRs sent around (rebase_required): not green, and not re-checked until they push. */
  goAround: Set<string> = new Set(),
): Map<string, AttemptVerdict> {
  const out = new Map<string, AttemptVerdict>();
  const byTask = new Map<string, Attempt[]>();
  for (const a of attempts) if (a.fork.status === "active" && a.fork.head_sha !== a.fork.base_sha) byTask.set(a.task, [...(byTask.get(a.task) ?? []), a]);

  for (const [task, members] of byTask) {
    const group = members.map((a) => ({ ...a, green: isGreenNow(a.fork, baselineHead, pairsPending, goAround) }));
    const done = landed.find((l) => l.task === task);
    if (done) {
      for (const a of group)
        out.set(a.fork.name, { kind: "stand_down", winner: done.fork, final: true, reason: `${prLabel(done.fork)} already landed this task (${task}). Abandon this PR, or if it adds something, declare an intent with a new task and push.` });
      continue;
    }
    if (group.length < 2) continue;
    const ranked = [...group].sort((x, y) => (compareAttempts(x, y).winner === x ? -1 : 1));
    const best = ranked[0]!;
    const choice = choices.filter((c) => c.task === task && group.some((a) => a.fork.name === c.winner)).sort((x, y) => y.at - x.at)[0];
    if (choice) {
      const winner = group.find((a) => a.fork.name === choice.winner)!;
      const atc = (l: Attempt) => {
        if (winner !== best) return `picked by ${choice.by} over ATC's ranking (which preferred ${prLabel(best.fork.name)}: ${compareAttempts(best, winner).reason})`;
        return `${compareAttempts(winner, l).reason}; confirmed by ${choice.by}`;
      };
      const over = group.filter((a) => a !== winner).map((l) => ({ fork: l.fork.name, reason: atc(l) }));
      for (const o of over)
        out.set(o.fork, { kind: "stand_down", winner: winner.fork.name, final: false, reason: `Same task (${task}) as ${prLabel(winner.fork.name)}, which ships: ${o.reason}.` });
      out.set(winner.fork.name, { kind: "chosen", over });
      continue;
    }
    const waiting = group.filter((a) => !decided(a.fork, baselineHead, pairsPending, goAround));
    if (waiting.length) {
      for (const a of group)
        if (!waiting.includes(a) && isGreenNow(a.fork, baselineHead, pairsPending)) {
          const on = waiting.map((w) => w.fork.name);
          out.set(a.fork.name, { kind: "wait", on, reason: `Waiting for ${on.map(prLabel).join(", ")}, another attempt at the same task (${task}), to finish its checks; then ATC picks one.` });
        }
      continue;
    }
    if (!isGreenNow(best.fork, baselineHead, pairsPending, goAround)) continue; // none is green: each just has to fix itself
    const over = ranked.slice(1).map((l) => ({ fork: l.fork.name, reason: compareAttempts(best, l).reason }));
    for (const o of over)
      out.set(o.fork, { kind: "stand_down", winner: best.fork.name, final: false, reason: `Same task (${task}) as ${prLabel(best.fork.name)}, which ships: ${o.reason}.` });
    out.set(best.fork.name, { kind: "chosen", over });
  }
  return out;
}

/** The stand-down verdicts only (fork → verdict), for the sequence and the landing gate. */
export const standDowns = (v: Map<string, AttemptVerdict>) =>
  new Map([...v].filter((e): e is [string, Extract<AttemptVerdict, { kind: "stand_down" }>] => e[1].kind === "stand_down"));

import { prLabel } from "./atc";
import { CHECK_STUCK_MS, isGreen } from "./landing";
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
  /** When this PR started naming this task (its first intent in the current run naming it); default: when it opened. */
  since?: number;
};

/** What ATC says to one attempt. */
export type AttemptVerdict =
  /**
   * It doesn't ship: `winner` does. `final`: the winner already landed, so nothing this PR does changes that.
   * `basis`: what decided it ("final", "pick", or the compareAttempts step), stable while the counts in `reason` move.
   */
  | { kind: "stand_down"; winner: string; reason: string; final: boolean; basis: string }
  /** It's ahead, but another attempt is still being checked: wait for it, so the comparison is fair. */
  | { kind: "wait"; reason: string; on: string[] }
  /** It ships. `over`: the attempts it beat and why (for its flight log). */
  | { kind: "chosen"; over: Array<{ fork: string; reason: string }> };

/**
 * A person's pick for a task (table `task_choices`). It holds across the picked PR's pushes (a go-around ATC asked for
 * mustn't undo it) until someone picks again, or the picked PR is abandoned or leaves the task.
 */
export type TaskChoice = { task: string; winner: string; by: string; at: number };

/**
 * ATC's pick for a task that an unrelated landing sent around keeps the task this long while it fixes the go-around,
 * so a routine rebase doesn't hand the task to the attempt ATC ranked worse (review of #45). Then it counts as not green.
 */
export const LEADER_WAIT_MS = CHECK_STUCK_MS;

/**
 * The attempt that ships (ATC's pick or a person's) must show signs of life: a push, a land request or a new intent.
 * Quiet this long while it's the one to ship, and the next-best attempt gets the task, so an agent that stopped
 * can't stall the others (issue #19). Per baseline: POST /settings {"stallSeconds": n}.
 */
export const STALL_MS = 15 * 60_000;

/** "15 min" or "20 s". */
export const duration = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** Task keys are compared trimmed and case-insensitive; null for none. */
export function normalizeTask(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 100);
  return t || null;
}

/** What the verdicts need besides the attempts. */
export type VerdictContext = {
  baselineHead: string;
  /** PRs with a pair check against another PR's current head still outstanding. */
  pairsPending?: Set<string>;
  /** People's picks, latest per task. */
  choices?: TaskChoice[];
  /** PRs sent around (rebase_required): not green, and not re-checked until they push. */
  goAround?: Set<string>;
  /** PRs whose checks ATC stopped restarting (CHECK_MAX_RESTARTS): only a new push retries them. */
  gaveUp?: Set<string>;
  /** task → the attempt ATC chose last (table `task_leaders`). */
  leaders?: Map<string, string>;
  /** fork → when it was sent around (its open rebase_required signal). */
  sentAround?: Map<string, number>;
  now?: number;
  /** task → since when its leader (in `leaders`) has been ATC's pick. */
  leaderSince?: Map<string, number>;
  /** fork → its agent's last sign of life: a push, land request, intent, or its own clearance/signals poll. */
  lastActive?: Map<string, number>;
  /** fork → when its current head's checks last finished (the clock doesn't run while ATC is checking it). */
  checkedAt?: Map<string, number>;
  /** How long the attempt to ship may be quiet before the next one gets the task (STALL_MS). */
  stallMs?: number;
  /** fork → when ATC set it aside as quiet (table `task_stalls`); it stays aside until its agent acts again. */
  stalledAt?: Map<string, number>;
};

/**
 * Checked on current main, with every pair check in: green, red, or errored with no retries left. Until then the
 * comparison waits for it, so an attempt that's merely slower to check (or hit a passing checker error) doesn't lose.
 * A PR sent around is decided too: ATC doesn't re-check it until it pushes, so waiting for it could take forever.
 */
export function decided(f: ForkRow, { baselineHead, pairsPending = new Set(), goAround = new Set(), gaveUp = new Set() }: VerdictContext): boolean {
  if (goAround.has(f.name)) return true;
  // Errored for good at its head, even if its push was never indexed (review of #45): nothing more is coming.
  if (f.check_status === "error" && f.check_sha === f.head_sha) return gaveUp.has(f.name);
  if (f.check_sha !== f.head_sha || f.processed_sha !== f.head_sha) return false;
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
  return { winner, loser, step: "name", reason: "otherwise equal; ATC broke the tie by name" };
}

const isGreenNow = (f: ForkRow, { baselineHead, pairsPending = new Set(), goAround = new Set() }: VerdictContext) =>
  isGreen(f, baselineHead) && !pairsPending.has(f.name) && !goAround.has(f.name);

/**
 * ATC's verdict for every attempt that has one. Per task:
 *  - another attempt at it landed while this one was in flight: this one stands down (final);
 *  - a person picked one (and it's still in flight): that one ships, the rest stand down;
 *  - otherwise, while any attempt is still being checked, the decided green ones wait for it;
 *  - once all are decided, the best (compareAttempts) ships if it is green; the rest stand down.
 * Attempts without pushed changes don't count: an agent that never pushes can't hold up the other.
 */
export function attemptVerdicts(
  attempts: Attempt[],
  /** Landed PRs, the task their latest intent named, and when they landed. */
  landed: Array<{ fork: string; task: string; landedAt: number }>,
  ctx: VerdictContext,
): Map<string, AttemptVerdict> {
  const out = new Map<string, AttemptVerdict>();
  const byTask = new Map<string, Attempt[]>();
  for (const a of attempts) {
    if (a.fork.status !== "active" || a.fork.head_sha === a.fork.base_sha) continue;
    // Only a landing while this PR was in flight competes with it: a task key reused later (a follow-up on the same
    // ticket) must not be blocked by last week's landing (review of #45).
    const done = landed.filter((l) => l.task === a.task && l.landedAt >= (a.since ?? a.fork.created_at)).sort((x, y) => x.landedAt - y.landedAt)[0];
    if (done) {
      out.set(a.fork.name, { kind: "stand_down", winner: done.fork, final: true, basis: "final", reason: `${prLabel(done.fork)} already landed this task (${a.task}). Abandon this PR, or if it adds something, declare an intent with a new task and push.` });
      continue;
    }
    byTask.set(a.task, [...(byTask.get(a.task) ?? []), a]);
  }

  for (const [task, members] of byTask) {
    if (members.length < 2) continue;
    const group = members.map((a) => ({ ...a, green: isGreenNow(a.fork, ctx) }));
    // The attempt that would ship, if its agent has gone quiet, is set aside and the rest compared again (and again).
    const stalled: Attempt[] = [];
    let pool: Attempt[] = group;
    for (;;) {
      const r = decideTask(task, pool, ctx);
      if (r.winner && isStalled(task, r.winner, ctx)) {
        stalled.push(r.winner);
        pool = pool.filter((a) => a !== r.winner);
        if (pool.length > 1) continue;
        // One left: it ships (if it can pass the gate), over the quiet ones.
        const sole = pool[0]!;
        out.set(sole.fork.name, { kind: "chosen", over: stalled.map((q) => ({ fork: q.fork.name, reason: quietReason(q, ctx) })) });
        break;
      }
      for (const [fork, v] of r.verdicts) out.set(fork, v);
      if (stalled.length && r.winner) {
        const w = out.get(r.winner.fork.name);
        if (w?.kind === "chosen") w.over.push(...stalled.map((q) => ({ fork: q.fork.name, reason: quietReason(q, ctx) })));
      }
      break;
    }
    // Who the quiet ones hand over to: the one that ships now, else the best of the rest (still being checked, or red).
    const heir = pool.find((a) => out.get(a.fork.name)?.kind === "chosen") ?? [...pool].sort((x, y) => (compareAttempts(x, y).winner === x ? -1 : 1))[0];
    for (const q of stalled)
      out.set(q.fork.name, {
        kind: "stand_down", winner: heir?.fork.name ?? "", final: false, basis: "stalled",
        reason: `This PR was the one to ship for ${task}, but its agent showed no sign of life (a push, a land request, an intent or a clearance check) for ${duration(ctx.stallMs ?? STALL_MS)}, so ${heir ? prLabel(heir.fork.name) : "another attempt"} gets the task. Push or ask to land to compete again.`,
      });
  }
  return out;
}

/** Quiet this long while it was the one to ship: set aside. Only once it's decided (checks are ATC's job, not the agent's). */
function isStalled(task: string, a: Attempt, ctx: VerdictContext): boolean {
  const lastActive = ctx.lastActive?.get(a.fork.name) ?? a.fork.created_at;
  // Already set aside, and quiet since: stays aside. (Its heir is ATC's pick now, which would restart its clock below.)
  const at = ctx.stalledAt?.get(a.fork.name);
  if (at !== undefined && lastActive < at) return true;
  if (!decided(a.fork, ctx)) return false;
  const now = ctx.now ?? Date.now();
  // The clock starts when it became the one to ship: a loser has no reason to act until then.
  const since = ctx.leaders?.get(task) === a.fork.name ? (ctx.leaderSince?.get(task) ?? now) : now;
  const last = Math.max(lastActive, since, ctx.checkedAt?.get(a.fork.name) ?? 0);
  return now - last >= (ctx.stallMs ?? STALL_MS);
}

const quietReason = (q: Attempt, ctx: VerdictContext) => `${prLabel(q.fork.name)} went quiet for ${duration(ctx.stallMs ?? STALL_MS)}`;

/** One task's verdicts among `group` (2+ attempts), and the attempt that ships, if one does now. */
function decideTask(task: string, group: Attempt[], ctx: VerdictContext): { verdicts: Map<string, AttemptVerdict>; winner?: Attempt } {
  const out = new Map<string, AttemptVerdict>();
  if (group.length < 2) return { verdicts: out };
  const ranked = [...group].sort((x, y) => (compareAttempts(x, y).winner === x ? -1 : 1));
  const best = ranked[0]!;
  const choice = (ctx.choices ?? []).filter((c) => c.task === task && group.some((a) => a.fork.name === c.winner)).sort((x, y) => y.at - x.at)[0];
  if (choice) {
    const winner = group.find((a) => a.fork.name === choice.winner)!;
    const atc = (l: Attempt) => {
      if (winner !== best) return `picked by ${choice.by} over ATC's ranking (which preferred ${prLabel(best.fork.name)}: ${compareAttempts(best, winner).reason})`;
      return `${compareAttempts(winner, l).reason}; confirmed by ${choice.by}`;
    };
    const over = group.filter((a) => a !== winner).map((l) => ({ fork: l.fork.name, reason: atc(l) }));
    for (const o of over)
      out.set(o.fork, { kind: "stand_down", winner: winner.fork.name, final: false, basis: "pick", reason: `Same task (${task}) as ${prLabel(winner.fork.name)}, which ships: ${o.reason}.` });
    out.set(winner.fork.name, { kind: "chosen", over });
    return { verdicts: out, winner };
  }
  // ATC's pick, sent around by another PR's landing: the task stays its own while it fixes that, up to LEADER_WAIT_MS.
  const sentAt = (a: Attempt) => ctx.sentAround?.get(a.fork.name);
  const held = (a: Attempt) =>
    ctx.leaders?.get(task) === a.fork.name && (ctx.goAround ?? new Set()).has(a.fork.name) && (ctx.now ?? Date.now()) - (sentAt(a) ?? 0) < LEADER_WAIT_MS;
  const waiting = group.filter((a) => held(a) || !decided(a.fork, ctx));
  if (waiting.length) {
    for (const a of group)
      if (!waiting.includes(a) && a.green) {
        const on = waiting.map((w) => w.fork.name);
        const leader = waiting.find(held);
        out.set(a.fork.name, {
          kind: "wait", on,
          reason: leader
            ? `Waiting for ${prLabel(leader.fork.name)}, ATC's pick for this task (${task}): another landing sent it around, and it gets ${Math.round(LEADER_WAIT_MS / 60_000)} min to fix that before ATC picks again.`
            : `Waiting for ${on.map(prLabel).join(", ")}, another attempt at the same task (${task}), to finish its checks; then ATC picks one.`,
        });
      }
    return { verdicts: out };
  }
  if (!best.green) return { verdicts: out }; // none is green: each just has to fix itself
  const over = ranked.slice(1).map((l) => ({ fork: l.fork.name, ...compareAttempts(best, l) }));
  for (const o of over)
    out.set(o.fork, { kind: "stand_down", winner: best.fork.name, final: false, basis: o.step, reason: `Same task (${task}) as ${prLabel(best.fork.name)}, which ships: ${o.reason}.` });
  out.set(best.fork.name, { kind: "chosen", over: over.map((o) => ({ fork: o.fork, reason: o.reason })) });
  return { verdicts: out, winner: best };
}

/** The stand-down verdicts only (fork → verdict), for the sequence and the landing gate. */
export const standDowns = (v: Map<string, AttemptVerdict>) =>
  new Map([...v].filter((e): e is [string, Extract<AttemptVerdict, { kind: "stand_down" }>] => e[1].kind === "stand_down"));

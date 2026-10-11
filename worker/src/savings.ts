/**
 * What ATC saved in one run, in numbers (issue #17, ADR-0019), computed from the event log alone so a replay shows
 * the same numbers as the live run.
 *
 * "Naive" is a rebase-on-every-main-move policy: each landing makes every other open PR that has pushed work rebase.
 */

export type LogEvent = { at: number; kind: string; fork: string | null; detail: unknown };

export interface Savings {
  prs: number;
  landed: number;
  /** Distinct pairs of PRs that got a speculative merge + typecheck. */
  pairsChecked: number;
  /** Pair checks run in total (a new push re-checks its pairs). */
  pairRuns: number;
  /** Pairs found to conflict (textually or by typecheck). */
  conflicts: number;
  /** Push → conflict signal for each conflicting pair, from the later of the two pushes. */
  signalMs: number[];
  typechecks: number;
  cacheHits: number;
  /** Go-arounds ATC asked for. */
  rebases: number;
  naiveRebases: number;
  /** Request to land → landed, per landed PR. */
  waitMs: number[];
  /** First PR opened → last landing. */
  elapsedMs: number;
}

type Detail = { a?: string; b?: string; status?: string; fresh?: boolean; timings?: Array<{ step?: string; cached?: boolean }> };

export function computeSavings(events: LogEvent[]): Savings {
  const s: Savings = { prs: 0, landed: 0, pairsChecked: 0, pairRuns: 0, conflicts: 0, signalMs: [], typechecks: 0, cacheHits: 0, rebases: 0, naiveRebases: 0, waitMs: [], elapsedMs: 0 };
  const open = new Set<string>();
  const lastPush = new Map<string, number>();
  const requested = new Map<string, number>();
  const pairs = new Set<string>();
  const conflicting = new Set<string>();
  let first: number | null = null;
  let lastLanding: number | null = null;

  const pushed = new Set<string>();
  // Stable sort: events in the same millisecond keep log order (callers pass them by id).
  for (const e of [...events].sort((x, y) => x.at - y.at)) {
    const d = (e.detail ?? {}) as Detail;
    switch (e.kind) {
      case "fork.created":
        if (e.fork) open.add(e.fork);
        s.prs++;
        first ??= e.at;
        break;
      case "fork.abandoned":
        if (e.fork) open.delete(e.fork);
        break;
      case "push.received":
        if (e.fork) (lastPush.set(e.fork, e.at), pushed.add(e.fork));
        break;
      case "land.requested":
        if (e.fork && !requested.has(e.fork)) requested.set(e.fork, e.at);
        break;
      case "land.merged":
        if (!e.fork) break;
        open.delete(e.fork);
        s.naiveRebases += [...open].filter((f) => pushed.has(f)).length; // a PR with nothing pushed has nothing to rebase
        s.landed++;
        if (requested.has(e.fork)) s.waitMs.push(e.at - requested.get(e.fork)!);
        lastLanding = e.at;
        break;
      case "signal.rebase_required":
        s.rebases++;
        break;
      case "check.single":
      case "check.pair": {
        for (const t of d.timings ?? []) {
          if (!t.step?.startsWith("typecheck")) continue;
          s.typechecks++;
          if (t.cached) s.cacheHits++;
        }
        if (e.kind === "check.single" || !d.a || !d.b || d.fresh === false) break;
        s.pairRuns++;
        const key = [d.a, d.b].sort().join("|");
        pairs.add(key);
        if ((d.status === "semantic_conflict" || d.status === "textual_conflict") && !conflicting.has(key)) {
          conflicting.add(key);
          const pushed = Math.max(lastPush.get(d.a) ?? e.at, lastPush.get(d.b) ?? e.at);
          s.signalMs.push(e.at - pushed);
        }
        break;
      }
    }
  }
  s.pairsChecked = pairs.size;
  s.conflicts = conflicting.size;
  s.elapsedMs = first !== null && lastLanding !== null ? lastLanding - first : 0;
  return s;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

/** One line for run.sh and the form: "5 PRs · 10 pairs checked · 1 conflict found in 12 s · 1 rebase (naive: 10)". */
export function savingsLine(s: Savings): string {
  const found = s.signalMs.length ? ` found ${s.signalMs.length > 1 ? "within" : "in"} ${secs(Math.max(...s.signalMs))}` : "";
  return [
    plural(s.prs, "PR"),
    `${plural(s.pairsChecked, "pair")} checked`,
    `${plural(s.conflicts, "conflict")}${found}`,
    `${plural(s.rebases, "rebase")} (naive: ${s.naiveRebases})`,
  ].join(" · ");
}

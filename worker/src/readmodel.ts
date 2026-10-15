/**
 * The Coordinator's read side (issue #10): what dashboards, agents and the replay read, built from its SQLite tables.
 * Pure functions of the storage; the Coordinator adds the parts only it can compute (sequence, approach).
 */
import { prLabel, type SequenceEntry } from "./atc";
import { computeSavings, type LogEvent } from "./savings";
import type { CoordinatorState, FlightLogEntry, ForkRow, Overlap, SignalData, SignalRow } from "./types";

/** File-level and symbol-level overlaps between every pair of active forks. */
export function overlaps(sql: SqlStorage): Overlap[] {
  const files = sql
    .exec<{ a: string; b: string; path: string }>(
      `SELECT t1.fork AS a, t2.fork AS b, t1.path AS path FROM touched t1
       JOIN touched t2 ON t1.path = t2.path AND t1.fork < t2.fork
       JOIN forks f1 ON f1.name = t1.fork AND f1.status = 'active'
       JOIN forks f2 ON f2.name = t2.fork AND f2.status = 'active'`,
    )
    .toArray()
    .map((r): Overlap => ({ kind: "file", forks: [r.a, r.b], path: r.path, symbol: null, detail: `both forks modify ${r.path}` }));

  // Fork X changes the signature of / removes an export that fork Y's touched files import.
  const symbols = sql
    .exec<{ changer: string; user: string; name: string; path: string; change: string; user_path: string; before_sig: string | null; after_sig: string | null }>(
      `SELECT s.fork AS changer, u.fork AS user, s.name, s.path, s.change, u.path AS user_path, s.before_sig, s.after_sig
       FROM symbol_changes s
       JOIN uses u ON u.symbol = s.name AND u.from_path = s.path AND u.fork <> s.fork
       JOIN forks f1 ON f1.name = s.fork AND f1.status = 'active'
       JOIN forks f2 ON f2.name = u.fork AND f2.status = 'active'
       WHERE s.change IN ('signature_changed', 'removed')`,
    )
    .toArray()
    .map(
      (r): Overlap => ({
        kind: "symbol",
        forks: [r.changer, r.user],
        path: r.path,
        symbol: r.name,
        detail: `${r.changer} ${r.change === "removed" ? "removes" : "changes the signature of"} ${r.name} (${r.path}); ${r.user} uses it in ${r.user_path}`,
      }),
    );
  return [...files, ...symbols];
}

/** Landed PRs' flight logs, oldest first (ADR-0019). */
export function flightLogs(sql: SqlStorage): FlightLogEntry[] {
  return sql
    .exec<{ fork: string; landed_sha: string; landed_at: number; note: string; noted: number }>("SELECT fork, landed_sha, landed_at, note, noted FROM flight_logs ORDER BY landed_at")
    .toArray()
    .map((r) => ({ fork: r.fork, pr: prLabel(r.fork), landedSha: r.landed_sha, landedAt: r.landed_at, note: r.note, noted: r.noted === 1 }));
}

export type Live = Pick<CoordinatorState, "baseline" | "baselineHead" | "approach" | "reviewRequired" | "awaitingReview"> & { sequence: SequenceEntry[] };

/** Everything a dashboard shows. `live` is what only the Coordinator computes (the ATC sequence, the approach order). */
export function readModel(sql: SqlStorage, live: Live): CoordinatorState {
  const forks = sql.exec<ForkRow>("SELECT * FROM forks ORDER BY created_at").toArray();
  const touched = sql.exec<{ fork: string; path: string; change: string; lines: number }>("SELECT * FROM touched").toArray();
  const symbolChanges = sql
    .exec<{ fork: string; path: string; name: string; kind: string; change: string; before_sig: string | null; after_sig: string | null }>("SELECT * FROM symbol_changes")
    .toArray();
  return {
    baseline: live.baseline,
    baselineHead: live.baselineHead,
    forks: forks.map((f) => ({
      ...f,
      files: touched.filter((t) => t.fork === f.name),
      symbols: symbolChanges.filter((s) => s.fork === f.name),
    })),
    overlaps: overlaps(sql),
    approach: live.approach,
    reviewRequired: live.reviewRequired,
    awaitingReview: live.awaitingReview,
    sequence: live.sequence,
    signals: sql
      .exec<SignalRow & { data: string }>("SELECT * FROM signals ORDER BY id DESC LIMIT 100")
      .toArray()
      .map((r) => ({ ...r, data: JSON.parse(r.data) as SignalData })),
    intents: sql
      .exec<{ id: number; fork: string; description: string; files: string; symbols: string; created_at: number; task: string | null }>("SELECT * FROM intents ORDER BY id")
      .toArray()
      .map((i) => ({ ...i, files: JSON.parse(i.files) as string[], symbols: JSON.parse(i.symbols) as string[] })),
    flightLogs: flightLogs(sql),
    savings: computeSavings(
      sql
        .exec<{ at: number; kind: string; fork: string | null; detail: string }>(
          `SELECT at, kind, fork, detail FROM event_log WHERE kind IN ('fork.created', 'fork.abandoned', 'push.received', 'land.requested', 'land.merged', 'signal.rebase_required', 'check.single', 'check.single.stale', 'check.pair') ORDER BY id`,
        )
        .toArray()
        .map((e): LogEvent => ({ ...e, detail: JSON.parse(e.detail) as unknown })),
    ),
    events: sql
      .exec<{ id: number; at: number; kind: string; fork: string | null; detail: string }>("SELECT * FROM event_log ORDER BY id DESC LIMIT 60")
      .toArray()
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) as unknown })),
  };
}

/** The compact snapshot a replay needs (ADR-0014); flight logs never change once written, so the timeline carries them once. */
export function compactSnapshot(model: CoordinatorState): string {
  return JSON.stringify({
    baseline: model.baseline,
    baselineHead: model.baselineHead,
    forks: model.forks.map(({ name, pr, status, landed_at, check_status, check_sha, head_sha, base_sha, diff_lines }) => ({ name, pr, status, landed_at, check_status, check_sha, head_sha, base_sha, diff_lines })),
    sequence: model.sequence,
    signals: model.signals
      .filter((x) => x.resolved_at === null && ["semantic_conflict", "merge_conflict", "rebase_required"].includes(x.kind))
      .map(({ kind, fork, about_fork, symbol }) => ({ kind, fork, about_fork, symbol, resolved_at: null })),
    savings: model.savings,
  });
}

/** Record a snapshot for replay, only when the airspace actually changed. */
export function recordSnapshot(sql: SqlStorage, model: CoordinatorState) {
  const compact = compactSnapshot(model);
  const last = sql.exec<{ state: string }>("SELECT state FROM snapshots ORDER BY id DESC LIMIT 1").toArray()[0]?.state;
  if (last !== compact) sql.exec("INSERT INTO snapshots(at, state) VALUES (?, ?)", Date.now(), compact);
}

/** Full recording for replay: every snapshot plus every event (pre-serialized: snapshots are stored as JSON). */
export function timelineJson(sql: SqlStorage, baseline: string | null): string {
  const snapshots = sql.exec<{ at: number; state: string }>("SELECT at, state FROM snapshots ORDER BY id").toArray();
  const events = sql.exec<{ id: number; at: number; kind: string; fork: string | null; detail: string }>("SELECT * FROM event_log ORDER BY id").toArray();
  return `{"baseline":${JSON.stringify(baseline)},"flightLogs":${JSON.stringify(flightLogs(sql))},"snapshots":[${snapshots.map((x) => `{"at":${x.at},"state":${x.state}}`).join(",")}],"events":[${events
    .map((e) => JSON.stringify({ id: e.id, at: e.at, kind: e.kind, fork: e.fork, detail: JSON.parse(e.detail) as unknown }))
    .join(",")}]}`;
}

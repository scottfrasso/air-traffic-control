/**
 * The Coordinator's signal store (issue #10): signals to agents, de-duplicated by key, refreshed in place, and
 * resolved when their cause goes away. Functions of the Coordinator's SQLite storage.
 */
import { prLabel } from "./atc";
import { DERIVED_KINDS, deriveSignals, type DesiredSignal, type IndexSnapshot, type SignalKind } from "./signals";
import type { ForkRow, SignalData, SignalRow } from "./types";

type Log = (kind: string, detail: unknown, fork: string | null) => void;

/** The in-flight index of the active forks, as the signal rules read it. */
export function indexSnapshot(sql: SqlStorage, active: ForkRow[]): IndexSnapshot {
  const forks = active.map((f) => ({ name: f.name, agent: f.agent }));
  const names = new Set(forks.map((f) => f.name));
  const keep = <T extends { fork: string }>(rows: T[]) => rows.filter((r) => names.has(r.fork));
  return {
    forks,
    touched: keep(sql.exec<{ fork: string; path: string; change: string }>("SELECT fork, path, change FROM touched").toArray()),
    symbolChanges: keep(
      sql
        .exec<{ fork: string; path: string; name: string; change: string; before_sig: string | null; after_sig: string | null }>(
          "SELECT fork, path, name, change, before_sig, after_sig FROM symbol_changes",
        )
        .toArray(),
    ),
    uses: keep(sql.exec<{ fork: string; path: string; symbol: string; from_path: string }>("SELECT * FROM uses").toArray()),
    intents: keep(
      sql
        .exec<{ fork: string; description: string; files: string; symbols: string }>("SELECT fork, description, files, symbols FROM intents ORDER BY id")
        .toArray()
        .map((i) => ({ ...i, files: JSON.parse(i.files) as string[], symbols: JSON.parse(i.symbols) as string[] })),
    ),
  };
}

/** Agents and the dashboard talk in PR numbers: replace fork repo names with "PR<N>". */
export function relabel(sql: SqlStorage, text: string): string {
  const names = sql.exec<{ name: string }>("SELECT name FROM forks ORDER BY length(name) DESC").toArray().map((r) => r.name);
  return names.reduce((t, n) => t.split(n).join(prLabel(n)), text);
}

/** Insert a signal unless an identical one (same dedupe key) is open; re-open it if it was resolved. True if new. */
export function emitSignal(sql: SqlStorage, log: Log, input: DesiredSignal): boolean {
  const s = { ...input, message: relabel(sql, input.message) };
  const existing = sql
    .exec<{ id: number; resolved_at: number | null; message: string }>("SELECT id, resolved_at, message FROM signals WHERE dedupe_key = ?", s.dedupe_key)
    .toArray()[0];
  if (existing && existing.resolved_at === null) {
    // Same fact, new reasons (e.g. "declared an intent" → "uses it in src/checkout.ts"): refresh in place.
    if (existing.message !== s.message) {
      sql.exec("UPDATE signals SET message = ?, data = ? WHERE id = ?", s.message, JSON.stringify(s.data), existing.id);
      log(`signal.${s.kind}.updated`, { to: s.fork, message: s.message }, s.fork);
    }
    return false;
  }
  if (existing) {
    sql.exec("UPDATE signals SET resolved_at = NULL, created_at = ?, message = ?, data = ? WHERE id = ?", Date.now(), s.message, JSON.stringify(s.data), existing.id);
  } else {
    sql.exec(
      "INSERT INTO signals(fork, kind, about_fork, symbol, message, data, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      s.fork, s.kind, s.about_fork, s.symbol, s.message, JSON.stringify(s.data), s.dedupe_key, Date.now(),
    );
  }
  log(`signal.${s.kind}`, { to: s.fork, message: s.message }, s.fork);
  return true;
}

export function resolveSignals(sql: SqlStorage, where: { fork?: string; kind?: SignalKind; about_fork?: string }) {
  const clauses = ["resolved_at IS NULL"];
  const args: string[] = [];
  for (const [col, val] of Object.entries(where)) if (val) (clauses.push(`${col} = ?`), args.push(val));
  sql.exec(`UPDATE signals SET resolved_at = ? WHERE ${clauses.join(" AND ")}`, Date.now(), ...args);
}

/** Recompute index-derived signals; emit new ones and resolve ones that no longer hold. */
export function syncDerivedSignals(sql: SqlStorage, log: Log, snapshot: IndexSnapshot) {
  const desired = deriveSignals(snapshot);
  const keys = new Set(desired.map((d) => d.dedupe_key));
  for (const d of desired) emitSignal(sql, log, d);
  const placeholders = DERIVED_KINDS.map(() => "?").join(",");
  const open = sql
    .exec<{ id: number; dedupe_key: string }>(`SELECT id, dedupe_key FROM signals WHERE resolved_at IS NULL AND kind IN (${placeholders})`, ...DERIVED_KINDS)
    .toArray();
  for (const o of open) if (!keys.has(o.dedupe_key)) sql.exec("UPDATE signals SET resolved_at = ? WHERE id = ?", Date.now(), o.id);
}

/** Signals addressed to `fork`. Open ones by default; `includeResolved` for history. */
export function signalsFor(sql: SqlStorage, fork: string, includeResolved = false): SignalRow[] {
  return sql
    .exec<SignalRow & { data: string }>(`SELECT * FROM signals WHERE fork = ? ${includeResolved ? "" : "AND resolved_at IS NULL"} ORDER BY id`, fork)
    .toArray()
    .map((r) => ({ ...r, data: JSON.parse(r.data) as SignalData }));
}

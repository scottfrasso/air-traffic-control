/** Coordinator DO SQLite schema. Idempotent; runs in the constructor. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS forks(
  name TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  pr INTEGER NOT NULL DEFAULT 0,      -- pull request number, assigned by ATC per baseline
  status TEXT NOT NULL,              -- active | landed | abandoned
  created_at INTEGER NOT NULL,
  base_sha TEXT NOT NULL,            -- baseline commit the fork's work sits on
  head_sha TEXT NOT NULL,            -- latest pushed sha
  processed_sha TEXT NOT NULL,       -- latest sha whose index has been applied
  diff_lines INTEGER NOT NULL DEFAULT 0,
  subscription_id TEXT,
  remote TEXT NOT NULL,
  land_requested_at INTEGER,
  landed_at INTEGER,
  check_status TEXT NOT NULL DEFAULT 'unknown',  -- unknown | pending | green | red | error (its check pipeline failed for good)
  check_sha TEXT,
  check_base TEXT,                   -- main commit the PR was merged onto for its check
  check_detail TEXT,
  check_main_conflict INTEGER NOT NULL DEFAULT 0  -- 1: fine alone, but doesn't fit on current main (go around)
);

CREATE TABLE IF NOT EXISTS touched(
  fork TEXT NOT NULL, path TEXT NOT NULL, change TEXT NOT NULL, lines INTEGER NOT NULL,
  PRIMARY KEY(fork, path));

CREATE TABLE IF NOT EXISTS symbol_changes(
  fork TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  change TEXT NOT NULL, before_sig TEXT, after_sig TEXT,
  PRIMARY KEY(fork, path, name));

CREATE TABLE IF NOT EXISTS uses(
  fork TEXT NOT NULL, path TEXT NOT NULL, symbol TEXT NOT NULL, from_path TEXT NOT NULL,
  PRIMARY KEY(fork, path, symbol, from_path));

CREATE TABLE IF NOT EXISTS intents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fork TEXT NOT NULL, description TEXT NOT NULL,
  files TEXT NOT NULL, symbols TEXT NOT NULL,   -- JSON arrays
  created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fork TEXT NOT NULL,                -- recipient
  kind TEXT NOT NULL,                -- overlap | signature_change | semantic_conflict | rebase_required | landed | info
  about_fork TEXT,
  symbol TEXT,
  message TEXT NOT NULL,
  data TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER);

CREATE TABLE IF NOT EXISTS pair_checks(
  fork_a TEXT NOT NULL, fork_b TEXT NOT NULL, sha_a TEXT NOT NULL, sha_b TEXT NOT NULL,
  status TEXT NOT NULL,              -- clean | textual_conflict | semantic_conflict | error
  detail TEXT NOT NULL, checked_at INTEGER NOT NULL,
  PRIMARY KEY(fork_a, fork_b));

-- Pair checks started (by a push pipeline or a re-queue) and not yet known to be done; one row per pair.
CREATE TABLE IF NOT EXISTS pair_queue(
  fork_a TEXT NOT NULL, fork_b TEXT NOT NULL, sha_a TEXT NOT NULL, sha_b TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  PRIMARY KEY(fork_a, fork_b));

-- The latest check pipeline (push or re-check) started per fork, to restart stuck or failed ones (issue #2).
CREATE TABLE IF NOT EXISTS check_runs(fork TEXT PRIMARY KEY, sha TEXT NOT NULL, started_at INTEGER NOT NULL, restarts INTEGER NOT NULL);

-- When each fork's current head was first seen (to tell "being indexed" from "stuck").
CREATE TABLE IF NOT EXISTS head_seen(fork TEXT PRIMARY KEY, sha TEXT NOT NULL, at INTEGER NOT NULL);

-- Recorded airspace snapshots for replay (one per state change, de-duplicated).
CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, state TEXT NOT NULL);

-- Outbound webhooks: every event is POSTed to each URL.
CREATE TABLE IF NOT EXISTS webhooks(url TEXT PRIMARY KEY, secret TEXT, created_at INTEGER NOT NULL);

-- Flight log per landed PR (ADR-0019): the note ATC wrote to refs/notes/atc on the landed commit.
CREATE TABLE IF NOT EXISTS flight_logs(
  fork TEXT PRIMARY KEY, landed_sha TEXT NOT NULL, landed_at INTEGER NOT NULL,
  note TEXT NOT NULL, noted INTEGER NOT NULL, note_error TEXT);

CREATE TABLE IF NOT EXISTS event_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, kind TEXT NOT NULL, fork TEXT, detail TEXT NOT NULL);
`;

/** Columns added after a table first shipped: existing Durable Objects get them through ALTER TABLE (idempotent). */
export const COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "forks", column: "check_main_conflict", ddl: "ALTER TABLE forks ADD COLUMN check_main_conflict INTEGER NOT NULL DEFAULT 0" },
];

/** RepoStore SQLite schema (one Durable Object per repo). Idempotent; runs in the constructor. */
export const REPO_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS prs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, author TEXT NOT NULL,
  source TEXT NOT NULL, target TEXT NOT NULL,
  state TEXT NOT NULL,                 -- draft | ready | merged | closed
  head TEXT NOT NULL, base TEXT,
  intent TEXT NOT NULL,                -- JSON Intent
  created_at INTEGER NOT NULL,
  current_run INTEGER);                -- the run in charge; record calls from any other run are dropped

-- One review run per trigger (run checks, or ready): for one head commit, all checks or some.
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr INTEGER NOT NULL, sha TEXT NOT NULL,
  number INTEGER NOT NULL,             -- 1st, 2nd, ... run of this PR
  status TEXT NOT NULL,                -- running | done | ci_failed | cancelled
  since_sha TEXT,                      -- head of the last finished run (reviewers see the diff since)
  classification TEXT,                 -- JSON Classification
  ci_config TEXT,                      -- the head's .atc/ci.yml (merge re-runs it on the merged commit)
  instance TEXT NOT NULL,              -- Workflow instance id
  scope TEXT,                          -- JSON CheckName[] for a partial run (single checks); NULL: everything
  delta TEXT,                          -- JSON paths changed since the last reviewed commit; NULL on a first review
  sessions TEXT,                       -- JSON Managed Agents session ids, interrupted if the run is cancelled
  started_at INTEGER NOT NULL, finished_at INTEGER);

-- CI commands (kind ci) and pipeline steps (kind step: classifier, each reviewer, verification).
CREATE TABLE IF NOT EXISTS checks(
  run INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, log TEXT NOT NULL, ms INTEGER NOT NULL,
  PRIMARY KEY(run, name));

CREATE TABLE IF NOT EXISTS findings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr INTEGER NOT NULL, run INTEGER NOT NULL, sha TEXT NOT NULL, reviewer TEXT NOT NULL,
  file TEXT NOT NULL, line INTEGER NOT NULL, severity TEXT NOT NULL, class TEXT NOT NULL,
  title TEXT NOT NULL, evidence TEXT NOT NULL, suggestion TEXT,
  status TEXT NOT NULL,                -- open | fixed | resolved
  res_kind TEXT, res_reason TEXT, res_by TEXT);

-- A person's approval of one commit.
CREATE TABLE IF NOT EXISTS approvals(pr INTEGER NOT NULL, sha TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(pr, sha, by));

-- The PR diff (base...head) for the web UI, per head commit.
CREATE TABLE IF NOT EXISTS diffs(sha TEXT NOT NULL, base TEXT NOT NULL, diff TEXT NOT NULL, paths TEXT NOT NULL, PRIMARY KEY(sha, base));

CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, pr INTEGER, kind TEXT NOT NULL, detail TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS events_by_pr ON events(pr, id);
CREATE INDEX IF NOT EXISTS findings_by_pr ON findings(pr, status);
CREATE INDEX IF NOT EXISTS runs_by_pr ON runs(pr, id);
`;

/** Columns added after a store was first created: added in place, once. */
export const REPO_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "runs", column: "scope", ddl: "ALTER TABLE runs ADD COLUMN scope TEXT" },
  // Paths changed since the last reviewed commit (JSON; NULL on a first review): only their findings can become fixed.
  { table: "runs", column: "delta", ddl: "ALTER TABLE runs ADD COLUMN delta TEXT" },
  // Managed Agents sessions the run started (JSON), so cancelling the run stops them too.
  { table: "runs", column: "sessions", ddl: "ALTER TABLE runs ADD COLUMN sessions TEXT" },
];

/** Flat JSON record for signal payloads (RPC typing turns `unknown` into `never` and chokes on recursive types). */
export type SignalData = Record<string, string | number | boolean | null | string[]>;

export type PushSource = "event" | "reconcile" | "land";

// A type alias (not an interface) so it satisfies SqlStorage row constraints.
export type ForkRow = {
  name: string;
  agent: string;
  pr: number;
  status: "active" | "landed" | "abandoned";
  created_at: number;
  base_sha: string;
  head_sha: string;
  processed_sha: string;
  diff_lines: number;
  subscription_id: string | null;
  remote: string;
  land_requested_at: number | null;
  landed_at: number | null;
  check_status: "unknown" | "pending" | "green" | "red" | "error";
  /** 1: the PR is fine alone but doesn't fit on current main, so it must go around (was an "on main:" detail prefix). */
  check_main_conflict?: number;
  check_sha: string | null;
  check_base: string | null;
  check_detail: string | null;
};

export interface ForkCredentials {
  fork: string;
  /** Pull request number, e.g. 3 → "PR3". */
  pr: number;
  agent: string;
  remote: string;
  /** Write token for the fork. */
  token: string;
  baseline: string;
  baselineRemote: string;
  /** Read token for the baseline (to fetch and rebase). */
  baselineToken: string;
  baseSha: string;
}

export interface Overlap {
  kind: "file" | "symbol";
  forks: [string, string];
  path: string;
  symbol: string | null;
  detail: string;
}

export interface CoordinatorState {
  baseline: string | null;
  baselineHead: string | null;
  forks: Array<
    ForkRow & {
      files: Array<{ path: string; change: string; lines: number }>;
      symbols: Array<{ path: string; name: string; kind: string; change: string; before_sig: string | null; after_sig: string | null }>;
    }
  >;
  overlaps: Overlap[];
  /** Active forks in landing order: index 0 is next to land. */
  approach: string[];
  /** Review gate on (issue #16): PRs need an approval at their head before they're cleared. */
  reviewRequired: boolean;
  /** ATC landing sequence with one clearance + reason per PR. */
  sequence: import("./atc").SequenceEntry[];
  signals: SignalRow[];
  intents: Array<{ id: number; fork: string; description: string; files: string[]; symbols: string[]; created_at: number }>;
  /** Landed PRs' flight logs, oldest first (ADR-0019). */
  flightLogs: FlightLogEntry[];
  /** What ATC saved in this run, from the event log (issue #17). */
  savings: import("./savings").Savings;
  events: Array<{ id: number; at: number; kind: string; fork: string | null; detail: unknown }>;
}

export type FlightLogEntry = {
  fork: string;
  pr: string;
  landedSha: string;
  landedAt: number;
  /** The git note on the landed commit (refs/notes/atc). */
  note: string;
  /** False if the note couldn't be pushed; the text is still kept here. */
  noted: boolean;
};

export type SignalRow = {
  id: number;
  fork: string;
  kind: string;
  about_fork: string | null;
  symbol: string | null;
  message: string;
  data: SignalData;
  dedupe_key: string;
  created_at: number;
  resolved_at: number | null;
};

/** What review() answers: recorded, or refused with an HTTP status and why. */
export type ReviewResult =
  | { ok: true; fork: string; sha: string; verdict: string; clearance?: string }
  | { ok: false; status: number; error: string };

export type LandResponse = {
  landed: boolean;
  fork: string;
  reason?: string;
  baselineHead?: string;
  previousHead?: string;
  rebaseRequired?: string[];
  /** True when the caller should simply retry (checks running, landing in progress). */
  retry?: boolean;
  /** What ATC says about this PR's place in the sequence. */
  atc?: string;
};

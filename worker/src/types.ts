export type PushSource = "event" | "reconcile" | "land";

// A type alias (not an interface) so it satisfies SqlStorage row constraints.
export type ForkRow = {
  name: string;
  agent: string;
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
  check_status: "unknown" | "pending" | "green" | "red";
  check_sha: string | null;
  check_detail: string | null;
};

export interface ForkCredentials {
  fork: string;
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
  events: Array<{ id: number; at: number; kind: string; fork: string | null; detail: unknown }>;
}

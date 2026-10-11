import type { Savings } from "../../../worker/src/savings.ts";
import { config } from "./env.ts";

export interface ForkCredentials {
  fork: string;
  pr: number;
  agent: string;
  remote: string;
  token: string;
  baseline: string;
  baselineRemote: string;
  baselineToken: string;
  baseSha: string;
}

export interface Signal {
  id: number;
  fork: string;
  kind: string;
  about_fork: string | null;
  symbol: string | null;
  message: string;
  created_at: number;
  resolved_at: number | null;
}

/** Thin client for the agentmesh HTTP API (what scripted agents use; MCP clients get the same tools). */
export class Agentmesh {
  constructor(readonly baseline: string) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${config.workerUrl}/api/repos/${this.baseline}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.apiKey()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error ?? JSON.stringify(json)}`);
    return json;
  }

  createFork = (agent: string) => this.call<ForkCredentials>("POST", "/forks", { agent });
  state = () => this.call<StateResponse>("GET", "/state");
  reconcile = () => this.call<{ found: number }>("POST", "/reconcile");
  abandon = (fork: string) => this.call<{ ok: boolean }>("DELETE", `/forks/${fork}`);
}

export interface StateResponse {
  baseline: string;
  baselineHead: string;
  forks: Array<{
    name: string;
    status: string;
    head_sha: string;
    processed_sha: string;
    base_sha: string;
    diff_lines: number;
    check_status: string;
    files: Array<{ path: string; change: string }>;
    symbols: Array<{ path: string; name: string; change: string }>;
  }>;
  overlaps: Array<{ kind: string; forks: [string, string]; path: string; symbol: string | null; detail: string }>;
  signals?: Signal[];
  sequence?: Array<{ fork: string; pr: string; position: number; clearance: string; reason: string }>;
  flightLogs?: Array<{ fork: string; pr: string; landedSha: string; note: string; noted: boolean }>;
  savings?: Savings;
  events: Array<{ at: number; kind: string; fork: string | null; detail: unknown }>;
}

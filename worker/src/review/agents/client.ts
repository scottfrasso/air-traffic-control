import type { Reviewer } from "../types";

/**
 * Review agents run as Claude Managed Agents sessions (Anthropic hosts the agent loop and a sandbox). The pipeline
 * only needs four things from them, behind this interface so tests use a fake: start a session with some files and a
 * message, see whether it's still running, collect the files it wrote, and interrupt it.
 * Sessions get read-only file resources and no repo credential (spec: "No repo credential ever enters a sandbox").
 */

export type Role = "classifier" | Reviewer | "verifier";

export interface SessionSpec {
  role: Role;
  /** Uploaded with `upload` first; mounted read-only at /mnt/session/uploads/<name> (mount_path is relative to that). */
  files: Array<{ name: string; fileId: string }>;
  message: string;
  /** Hard cap on what the session may spend, in US cents. */
  budgetCents: number;
  title: string;
}

export interface SessionResult {
  status: "done" | "errored" | "budget";
  /** Files the agent wrote to /mnt/session/outputs/, by file name. */
  outputs: Record<string, string>;
  error?: string;
}

export interface AgentClient {
  /** Upload a file once; any number of sessions can mount it. Returns the file id. */
  upload(name: string, data: Uint8Array | string): Promise<string>;
  start(spec: SessionSpec): Promise<string>;
  /** `output`: the one file the role must write; only it is downloaded (and capped). */
  poll(id: string, output: string): Promise<"running" | SessionResult>;
  interrupt(id: string): Promise<void>;
}

const BASE = "https://api.anthropic.com";
const AGENTS_BETA = "managed-agents-2026-04-01";
const FILES_BETA = "files-api-2025-04-14";
/** An output file bigger than this is refused: it must fit in a Workflow step result (1 MiB) with room to spare. */
export const MAX_OUTPUT_BYTES = 256 * 1024;
/** Outputs show up in the file list 1-3 s after the session goes idle (docs; seen live): look this many times. */
const OUTPUT_LOOKS = 4;
const OUTPUT_LOOK_GAP_MS = 2_000;

export class ManagedAgentsClient implements AgentClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: { apiKey: string; agentIds: Record<Role, string>; environmentId: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(extra: Record<string, string> = {}) {
    return { "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": `${AGENTS_BETA},${FILES_BETA}`, ...extra };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${BASE}${path}`, {
      method,
      headers: this.headers(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new Error(`Managed Agents ${method} ${path} → ${res.status}: ${message}`);
    }
    return (path.endsWith("/content") ? text : JSON.parse(text)) as T;
  }

  async upload(name: string, data: Uint8Array | string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([typeof data === "string" ? data : data.slice()]), name);
    return (await this.call<{ id: string }>("POST", "/v1/files", form)).id;
  }

  async start(spec: SessionSpec): Promise<string> {
    const resources = spec.files.map((f) => ({ type: "file", file_id: f.fileId, mount_path: `/${f.name}` }));
    const session = await this.call<{ id: string }>("POST", "/v1/sessions", {
      agent: { type: "agent", id: this.opts.agentIds[spec.role] },
      environment_id: this.opts.environmentId,
      title: spec.title.slice(0, 200),
      resources,
      budget: { type: "limit", max_list_cost: { amount: String(Math.round(spec.budgetCents)), currency: "USD" } },
      initial_events: [{ type: "user.message", content: [{ type: "text", text: spec.message }] }],
    });
    return session.id;
  }

  async poll(id: string, output: string): Promise<"running" | SessionResult> {
    const s = await this.call<{ status: string; stop_reason?: { type?: string } }>("GET", `/v1/sessions/${id}`);
    if (s.status === "running" || s.status === "rescheduling") return "running";
    if (s.status === "terminated") return { status: "errored", outputs: {}, error: "session terminated" };
    if (s.status !== "idle") return { status: "errored", outputs: {}, error: `unexpected session status ${s.status}` };
    const stop = s.stop_reason?.type ?? (await this.lastStopReason(id));
    if (stop === "budget_reached") return { status: "budget", outputs: {}, error: "budget reached" };
    if (stop === "requires_action") return { status: "errored", outputs: {}, error: "the agent asked for approval of a tool call" };
    const file = await this.outputFile(id, output);
    if (!file) return { status: "done", outputs: {} }; // the step reports the missing file as invalid output
    const text = await this.call<string>("GET", `/v1/files/${file.id}/content`);
    if (new TextEncoder().encode(text).byteLength > MAX_OUTPUT_BYTES) return { status: "errored", outputs: {}, error: `${output} is too large (over ${MAX_OUTPUT_BYTES / 1024} KB)` };
    return { status: "done", outputs: { [output]: text } };
  }

  /** The session's output file by name: only files the agent wrote (downloadable), never a mounted input. */
  private async outputFile(id: string, output: string): Promise<{ id: string } | undefined> {
    for (let look = 1; ; look++) {
      const list = await this.call<{ data: Array<{ id: string; filename: string; downloadable?: boolean }> }>("GET", `/v1/files?scope_id=${encodeURIComponent(id)}`);
      const file = list.data.filter((f) => f.downloadable !== false && f.filename.split("/").pop() === output).at(-1);
      if (file || look >= OUTPUT_LOOKS) return file;
      await this.sleep(OUTPUT_LOOK_GAP_MS);
    }
  }

  private async lastStopReason(id: string): Promise<string | undefined> {
    const ev = await this.call<{ data: Array<{ type: string; stop_reason?: { type?: string } }> }>("GET", `/v1/sessions/${id}/events?beta=true`);
    return ev.data.filter((e) => e.type === "session.status_idle").at(-1)?.stop_reason?.type;
  }

  async interrupt(id: string): Promise<void> {
    await this.call("POST", `/v1/sessions/${id}/events`, { events: [{ type: "user.interrupt" }] }).catch(() => undefined);
  }
}

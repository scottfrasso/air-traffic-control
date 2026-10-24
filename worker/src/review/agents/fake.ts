import type { AgentClient, Role, SessionResult, SessionSpec } from "./client";

/** Scripted stand-in for Managed Agents, for tests: each role answers from a function; unscripted roles error. */
export class FakeAgentClient implements AgentClient {
  readonly started: SessionSpec[] = [];
  readonly interrupted: string[] = [];
  /** Polls that answer "running" before the result, per session (to exercise waiting). */
  runningPolls = 0;
  private readonly scripts = new Map<Role, (spec: SessionSpec) => SessionResult | Promise<SessionResult>>();
  private readonly sessions = new Map<string, { spec: SessionSpec; polls: number }>();
  /** Uploaded files by id, so scripts can read what a session was given. */
  readonly uploads = new Map<string, { name: string; data: string }>();

  async upload(name: string, data: Uint8Array | string): Promise<string> {
    const id = `file-${this.uploads.size + 1}`;
    this.uploads.set(id, { name, data: typeof data === "string" ? data : new TextDecoder().decode(data) });
    return id;
  }

  /** The text of the file named `name` that `spec` was given. */
  file(spec: SessionSpec, name: string): string | undefined {
    const f = spec.files.find((x) => x.name === name);
    return f ? this.uploads.get(f.fileId)?.data : undefined;
  }

  script(role: Role, fn: (spec: SessionSpec) => SessionResult | Promise<SessionResult>): void {
    this.scripts.set(role, fn);
  }

  async start(spec: SessionSpec): Promise<string> {
    const id = `fake-${this.started.length + 1}`;
    this.started.push(spec);
    this.sessions.set(id, { spec, polls: 0 });
    return id;
  }

  async poll(id: string, _output?: string): Promise<"running" | SessionResult> {
    const s = this.sessions.get(id);
    if (!s) return { status: "errored", outputs: {}, error: `no session ${id}` };
    if (s.polls++ < this.runningPolls) return "running";
    const fn = this.scripts.get(s.spec.role);
    return fn ? fn(s.spec) : { status: "errored", outputs: {}, error: `no script for ${s.spec.role}` };
  }

  async interrupt(id: string): Promise<void> {
    this.interrupted.push(id);
  }
}

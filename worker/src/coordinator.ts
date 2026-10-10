import { DurableObject } from "cloudflare:workers";
import type { ArtifactsEvent } from "./events";

/** One Coordinator per baseline repo. Spike version: just an event log. */
export class Coordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS event_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL)`);
  }

  async recordArtifactsEvent(event: ArtifactsEvent): Promise<void> {
    this.sql.exec("INSERT INTO event_log(at, kind, detail) VALUES (?, ?, ?)", Date.now(), event.type, JSON.stringify(event));
  }

  async events(limit = 50) {
    return this.sql
      .exec<{ id: number; at: number; kind: string; detail: string }>("SELECT * FROM event_log ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) as unknown }));
  }
}

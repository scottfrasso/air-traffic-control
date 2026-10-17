import { DurableObject } from "cloudflare:workers";
import { hashToken, newToken, type Person } from "./identity";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people(email TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
-- Personal API tokens: only the SHA-256 is kept; the token itself is shown once, at creation.
CREATE TABLE IF NOT EXISTS tokens(
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, label TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS repos(name TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, subscription_id TEXT);
`;

/** Personal tokens last this long; make a new one in the UI (security review, 10-17). */
export const TOKEN_TTL_MS = 90 * 86_400_000;

/** One global instance ("directory"): people, their API tokens, and the list of repos. */
export class Directory extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    const cols = this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('tokens')").toArray().map((c) => c.name);
    if (!cols.includes("expires_at")) this.sql.exec("ALTER TABLE tokens ADD COLUMN expires_at INTEGER");
  }

  async ensurePerson(email: string): Promise<Person> {
    const e = email.trim().toLowerCase();
    const name = e.split("@")[0] ?? e;
    this.sql.exec("INSERT OR IGNORE INTO people(email, name, created_at) VALUES (?, ?, ?)", e, name, Date.now());
    const p = this.sql.exec<{ email: string; name: string }>("SELECT email, name FROM people WHERE email = ?", e).one();
    return { email: p.email, name: p.name };
  }

  async createToken(email: string, label: string): Promise<{ id: number; token: string }> {
    const person = await this.ensurePerson(email);
    const token = newToken();
    const now = Date.now();
    this.sql.exec("INSERT INTO tokens(email, label, hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", person.email, label.trim().slice(0, 80) || "token", await hashToken(token), now, now + TOKEN_TTL_MS);
    return { id: this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id, token };
  }

  async listTokens(email: string): Promise<Array<{ id: number; label: string; created_at: number }>> {
    return this.sql.exec<{ id: number; label: string; created_at: number }>("SELECT id, label, created_at FROM tokens WHERE email = ? AND revoked_at IS NULL ORDER BY id", email.toLowerCase()).toArray();
  }

  /** Only the token's own person can revoke it. */
  async revokeToken(email: string, id: number): Promise<void> {
    this.sql.exec("UPDATE tokens SET revoked_at = ? WHERE id = ? AND email = ? AND revoked_at IS NULL", Date.now(), id, email.toLowerCase());
  }

  async personForToken(hash: string): Promise<Person | null> {
    const p = this.sql
      .exec<{ email: string; name: string }>("SELECT p.email, p.name FROM tokens t JOIN people p ON p.email = t.email WHERE t.hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)", hash, Date.now())
      .toArray()[0];
    return p ? { email: p.email, name: p.name } : null;
  }

  async addRepo(name: string, by: string, subscriptionId: string | null): Promise<void> {
    this.sql.exec("INSERT INTO repos(name, created_by, created_at, subscription_id) VALUES (?, ?, ?, ?)", name, by, Date.now(), subscriptionId);
  }

  async listRepos(): Promise<Array<{ name: string; created_by: string; created_at: number }>> {
    return this.sql.exec<{ name: string; created_by: string; created_at: number }>("SELECT name, created_by, created_at FROM repos ORDER BY name").toArray();
  }

  async countRepos(by: string): Promise<number> {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM repos WHERE created_by = ?", by.toLowerCase()).one().n;
  }

  async hasRepo(name: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM repos WHERE name = ?", name).toArray().length > 0;
  }
}

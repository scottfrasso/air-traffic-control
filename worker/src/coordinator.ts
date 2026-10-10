import { DurableObject } from "cloudflare:workers";
import { forkName, headOf, type ForkIndex } from "./artifacts";
import { isPushed, type ArtifactsEvent } from "./events";
import { deletePushSubscription } from "./subscriptions";
import { SCHEMA } from "./schema";
import { DERIVED_KINDS, deriveSignals, intentConflicts, type DesiredSignal, type IndexSnapshot, type SignalKind } from "./signals";
import type { CoordinatorState, ForkCredentials, ForkRow, Overlap, PushSource, SignalData, SignalRow } from "./types";

const RECONCILE_MS = 5_000;
/** Stop polling after this long without a push or API activity, so idle DOs hibernate (and pick up new deploys). */
const RECONCILE_IDLE_MS = 10 * 60_000;

/**
 * One Coordinator per baseline repo (addressed by baseline name). Holds the in-flight index:
 * which forks exist, what each touched vs. its base, declared intents, signals, and an event log.
 */
export class Coordinator extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  // ── meta ────────────────────────────────────────────────────────────────

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private get baseline(): string {
    const b = this.meta("baseline");
    if (!b) throw new Error("coordinator not initialised; call ensure(baseline) first");
    return b;
  }

  /** Idempotent: records the baseline name and its current head. */
  async ensure(baseline: string): Promise<void> {
    this.touch();
    await this.scheduleReconcile();
    if (this.meta("baseline") === baseline) return;
    this.setMeta("baseline", baseline);
    const head = await headOf(this.env, baseline);
    if (head) this.setMeta("baseline_head", head.hash);
    this.log("baseline.registered", { baseline, head: head?.hash ?? null });
  }

  log(kind: string, detail: unknown, fork: string | null = null) {
    this.sql.exec("INSERT INTO event_log(at, kind, fork, detail) VALUES (?, ?, ?, ?)", Date.now(), kind, fork, JSON.stringify(detail));
  }

  // ── forks ───────────────────────────────────────────────────────────────

  private fork(name: string): ForkRow | null {
    return this.sql.exec<ForkRow>("SELECT * FROM forks WHERE name = ?", name).toArray()[0] ?? null;
  }

  private activeForks(): ForkRow[] {
    return this.sql.exec<ForkRow>("SELECT * FROM forks WHERE status = 'active' ORDER BY created_at").toArray();
  }

  /** Fork the baseline for `agent`, mint credentials, subscribe to its pushes, start tracking it. */
  async createFork(agent: string): Promise<ForkCredentials> {
    const baseline = this.baseline;
    const name = forkName(baseline, agent);
    if (this.fork(name)?.status === "active") throw new Error(`fork ${name} already exists`);

    using base = await this.env.ARTIFACTS.get(baseline);
    const baseHead = (await base.log({ ref: "main", limit: 1 }))[0];
    if (!baseHead) throw new Error(`baseline ${baseline} has no commits`);
    const forked = await base.fork(name, { description: `agentmesh fork for ${agent}`, defaultBranchOnly: true });
    const baselineRead = await base.createToken("read", 6 * 3600);

    const subscriptionId: string | null = null; // attached by the Worker via attachSubscription (ADR-0009)

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO forks(name, agent, status, created_at, base_sha, head_sha, processed_sha, subscription_id, remote)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET agent = excluded.agent, status = 'active', created_at = excluded.created_at,
         base_sha = excluded.base_sha, head_sha = excluded.head_sha, processed_sha = excluded.processed_sha,
         subscription_id = excluded.subscription_id, remote = excluded.remote, diff_lines = 0,
         land_requested_at = NULL, check_status = 'unknown', check_sha = NULL, check_detail = NULL`,
      name, agent, now, baseHead.hash, baseHead.hash, baseHead.hash, subscriptionId, forked.remote,
    );
    this.log("fork.created", { agent, baseSha: baseHead.hash, subscriptionId }, name);
    await this.scheduleReconcile();

    return {
      fork: name,
      agent,
      remote: forked.remote,
      token: forked.token,
      baseline,
      baselineRemote: (await base.info()).remote,
      baselineToken: baselineRead.plaintext,
      baseSha: baseHead.hash,
    };
  }

  /** Record (or log the failure of) the fork's push subscription, created by the stateless Worker. */
  async attachSubscription(fork: string, subscriptionId: string | null, error?: string): Promise<void> {
    if (subscriptionId) {
      this.sql.exec("UPDATE forks SET subscription_id = ? WHERE name = ?", subscriptionId, fork);
      this.log("subscription.created", { subscriptionId }, fork);
    } else this.log("subscription.failed", { error: error ?? "unknown" }, fork);
  }

  // ── pushes ──────────────────────────────────────────────────────────────

  /** Entry point for Artifacts push events (queue) and reconcile. De-duplicates by (repo, sha). */
  async onPush(repo: string, sha: string, source: PushSource, event?: ArtifactsEvent): Promise<void> {
    const baseline = this.meta("baseline");
    if (repo === baseline) {
      if (this.meta("baseline_head") === sha) return;
      this.setMeta("baseline_head", sha);
      this.log("baseline.pushed", { sha, source });
      return;
    }
    const fork = this.fork(repo);
    if (!fork || fork.status !== "active") {
      this.log("push.ignored", { repo, sha, source, reason: "unknown or inactive fork" }, repo);
      return;
    }
    if (fork.head_sha === sha) return;
    this.sql.exec("UPDATE forks SET head_sha = ?, check_status = 'pending' WHERE name = ?", sha, repo);
    this.log("push.received", { sha, source, commits: isPushed(event) ? event.payload.commits.map((c) => c.message) : undefined }, repo);
    await this.startPipeline(repo, sha);
  }

  private async startPipeline(fork: string, sha: string) {
    const id = `${fork}-${sha.slice(0, 12)}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
    try {
      await this.env.PUSH_PIPELINE.create({ id, params: { baseline: this.baseline, fork, sha } });
      this.log("pipeline.started", { sha, instance: id }, fork);
    } catch (err) {
      // Same push seen twice (event + reconcile, or queue redelivery) → instance already exists.
      this.log("pipeline.duplicate", { sha, error: (err as Error).message }, fork);
    }
  }

  /** Called by the Workflow once a fork has been diffed against its base. */
  async applyIndex(index: ForkIndex): Promise<void> {
    const fork = this.fork(index.fork);
    if (!fork || fork.status !== "active") return;
    if (fork.head_sha !== index.headSha) {
      this.log("index.stale", { indexed: index.headSha, head: fork.head_sha }, index.fork);
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM touched WHERE fork = ?", index.fork);
      this.sql.exec("DELETE FROM symbol_changes WHERE fork = ?", index.fork);
      this.sql.exec("DELETE FROM uses WHERE fork = ?", index.fork);
      for (const f of index.files) {
        this.sql.exec("INSERT INTO touched(fork, path, change, lines) VALUES (?, ?, ?, ?)", index.fork, f.path, f.change, f.lines);
        for (const s of f.symbols)
          this.sql.exec(
            "INSERT INTO symbol_changes(fork, path, name, kind, change, before_sig, after_sig) VALUES (?, ?, ?, ?, ?, ?, ?)",
            index.fork, f.path, s.name, s.kind, s.change, s.before, s.after,
          );
        for (const u of f.imports)
          this.sql.exec("INSERT OR IGNORE INTO uses(fork, path, symbol, from_path) VALUES (?, ?, ?, ?)", index.fork, f.path, u.name, u.from);
      }
      this.sql.exec(
        "UPDATE forks SET processed_sha = ?, base_sha = ?, diff_lines = ? WHERE name = ?",
        index.headSha, index.baseSha, index.diffLines, index.fork,
      );
      this.setMeta("baseline_head", index.baselineHead);
    });
    this.log("index.updated", { sha: index.headSha, base: index.baseSha, files: index.files.map((f) => f.path), diffLines: index.diffLines }, index.fork);
    this.syncDerivedSignals();
  }

  // ── intents & signals ───────────────────────────────────────────────────

  private snapshot(): IndexSnapshot {
    const forks = this.activeForks().map((f) => ({ name: f.name, agent: f.agent }));
    const active = new Set(forks.map((f) => f.name));
    const keep = <T extends { fork: string }>(rows: T[]) => rows.filter((r) => active.has(r.fork));
    return {
      forks,
      touched: keep(this.sql.exec<{ fork: string; path: string; change: string }>("SELECT fork, path, change FROM touched").toArray()),
      symbolChanges: keep(
        this.sql
          .exec<{ fork: string; path: string; name: string; change: string; before_sig: string | null; after_sig: string | null }>(
            "SELECT fork, path, name, change, before_sig, after_sig FROM symbol_changes",
          )
          .toArray(),
      ),
      uses: keep(this.sql.exec<{ fork: string; path: string; symbol: string; from_path: string }>("SELECT * FROM uses").toArray()),
      intents: keep(
        this.sql
          .exec<{ fork: string; description: string; files: string; symbols: string }>("SELECT fork, description, files, symbols FROM intents ORDER BY id")
          .toArray()
          .map((i) => ({ ...i, files: JSON.parse(i.files) as string[], symbols: JSON.parse(i.symbols) as string[] })),
      ),
    };
  }

  /** Insert a signal unless an identical one (same dedupe key) exists; re-open it if it was resolved. */
  emitSignal(s: DesiredSignal): boolean {
    const existing = this.sql
      .exec<{ id: number; resolved_at: number | null; message: string }>("SELECT id, resolved_at, message FROM signals WHERE dedupe_key = ?", s.dedupe_key)
      .toArray()[0];
    if (existing && existing.resolved_at === null) {
      // Same fact, new reasons (e.g. "declared an intent" → "uses it in src/checkout.ts"): refresh in place.
      if (existing.message !== s.message) {
        this.sql.exec("UPDATE signals SET message = ?, data = ? WHERE id = ?", s.message, JSON.stringify(s.data), existing.id);
        this.log(`signal.${s.kind}.updated`, { to: s.fork, message: s.message }, s.fork);
      }
      return false;
    }
    if (existing) {
      this.sql.exec("UPDATE signals SET resolved_at = NULL, created_at = ?, message = ?, data = ? WHERE id = ?", Date.now(), s.message, JSON.stringify(s.data), existing.id);
    } else {
      this.sql.exec(
        "INSERT INTO signals(fork, kind, about_fork, symbol, message, data, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        s.fork, s.kind, s.about_fork, s.symbol, s.message, JSON.stringify(s.data), s.dedupe_key, Date.now(),
      );
    }
    this.log(`signal.${s.kind}`, { to: s.fork, message: s.message }, s.fork);
    return true;
  }

  resolveSignals(where: { fork?: string; kind?: SignalKind; about_fork?: string }) {
    const clauses = ["resolved_at IS NULL"];
    const args: string[] = [];
    for (const [col, val] of Object.entries(where)) if (val) (clauses.push(`${col} = ?`), args.push(val));
    this.sql.exec(`UPDATE signals SET resolved_at = ? WHERE ${clauses.join(" AND ")}`, Date.now(), ...args);
  }

  /** Recompute index-derived signals; emit new ones and resolve ones that no longer hold. */
  private syncDerivedSignals() {
    const desired = deriveSignals(this.snapshot());
    const keys = new Set(desired.map((d) => d.dedupe_key));
    for (const d of desired) this.emitSignal(d);
    const placeholders = DERIVED_KINDS.map(() => "?").join(",");
    const open = this.sql
      .exec<{ id: number; dedupe_key: string }>(`SELECT id, dedupe_key FROM signals WHERE resolved_at IS NULL AND kind IN (${placeholders})`, ...DERIVED_KINDS)
      .toArray();
    for (const o of open) if (!keys.has(o.dedupe_key)) this.sql.exec("UPDATE signals SET resolved_at = ? WHERE id = ?", Date.now(), o.id);
  }

  /** Record what an agent plans to touch; return in-flight work it collides with. */
  async declareIntent(fork: string, description: string, files: string[], symbols: string[]) {
    const row = this.fork(fork);
    if (!row || row.status !== "active") throw new Error(`unknown or inactive fork ${fork}`);
    const conflicts = intentConflicts(this.snapshot(), fork, files, symbols);
    this.sql.exec(
      "INSERT INTO intents(fork, description, files, symbols, created_at) VALUES (?, ?, ?, ?, ?)",
      fork, description, JSON.stringify(files), JSON.stringify(symbols), Date.now(),
    );
    this.log("intent.declared", { description, files, symbols, conflicts: conflicts.length }, fork);
    this.syncDerivedSignals();
    return { fork, recorded: true, overlaps: conflicts };
  }

  /** Signals addressed to `fork`. Open ones by default; `includeResolved` for history. */
  async getSignals(fork: string, includeResolved = false): Promise<SignalRow[]> {
    return this.sql
      .exec<SignalRow & { data: string }>(
        `SELECT * FROM signals WHERE fork = ? ${includeResolved ? "" : "AND resolved_at IS NULL"} ORDER BY id`,
        fork,
      )
      .toArray()
      .map((r) => ({ ...r, data: JSON.parse(r.data) as SignalData }));
  }

  // ── overlaps ────────────────────────────────────────────────────────────

  /** File-level and symbol-level overlaps between every pair of active forks. */
  overlaps(): Overlap[] {
    const files = this.sql
      .exec<{ a: string; b: string; path: string }>(
        `SELECT t1.fork AS a, t2.fork AS b, t1.path AS path FROM touched t1
         JOIN touched t2 ON t1.path = t2.path AND t1.fork < t2.fork
         JOIN forks f1 ON f1.name = t1.fork AND f1.status = 'active'
         JOIN forks f2 ON f2.name = t2.fork AND f2.status = 'active'`,
      )
      .toArray()
      .map((r): Overlap => ({ kind: "file", forks: [r.a, r.b], path: r.path, symbol: null, detail: `both forks modify ${r.path}` }));

    // Fork X changes the signature of / removes an export that fork Y's touched files import.
    const symbols = this.sql
      .exec<{ changer: string; user: string; name: string; path: string; change: string; user_path: string; before_sig: string | null; after_sig: string | null }>(
        `SELECT s.fork AS changer, u.fork AS user, s.name, s.path, s.change, u.path AS user_path, s.before_sig, s.after_sig
         FROM symbol_changes s
         JOIN uses u ON u.symbol = s.name AND u.from_path = s.path AND u.fork <> s.fork
         JOIN forks f1 ON f1.name = s.fork AND f1.status = 'active'
         JOIN forks f2 ON f2.name = u.fork AND f2.status = 'active'
         WHERE s.change IN ('signature_changed', 'removed')`,
      )
      .toArray()
      .map(
        (r): Overlap => ({
          kind: "symbol",
          forks: [r.changer, r.user],
          path: r.path,
          symbol: r.name,
          detail: `${r.changer} ${r.change === "removed" ? "removes" : "changes the signature of"} ${r.name} (${r.path}); ${r.user} uses it in ${r.user_path}`,
        }),
      );
    return [...files, ...symbols];
  }

  // ── reconcile (ADR-0006) ────────────────────────────────────────────────

  private async scheduleReconcile() {
    if (this.activeForks().length === 0) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
  }

  async reconcile(): Promise<number> {
    let found = 0;
    const baseline = this.meta("baseline");
    if (baseline) {
      const head = await headOf(this.env, baseline);
      if (head && head.hash !== this.meta("baseline_head")) await this.onPush(baseline, head.hash, "reconcile");
    }
    await Promise.all(
      this.activeForks().map(async (f) => {
        const head = await headOf(this.env, f.name).catch(() => null);
        if (head && head.hash !== f.head_sha) {
          found++;
          await this.onPush(f.name, head.hash, "reconcile");
        }
      }),
    );
    return found;
  }

  /** Mark activity so the reconcile alarm keeps running; called on every API call and push. */
  touch() {
    this.setMeta("last_activity", String(Date.now()));
  }

  override async alarm(): Promise<void> {
    if (await this.reconcile()) this.touch();
    const idle = Date.now() - Number(this.meta("last_activity") ?? 0);
    if (this.activeForks().length > 0 && idle < RECONCILE_IDLE_MS) await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
    else this.log("reconcile.paused", { idleMs: idle });
  }

  // ── teardown ────────────────────────────────────────────────────────────

  async abandonFork(name: string): Promise<void> {
    const fork = this.fork(name);
    if (!fork) return;
    this.sql.exec("UPDATE forks SET status = 'abandoned' WHERE name = ?", name);
    if (fork.subscription_id) await deletePushSubscription(this.env, fork.subscription_id).catch(() => undefined);
    this.log("fork.abandoned", {}, name);
    this.resolveSignals({ fork: name });
    this.resolveSignals({ about_fork: name });
    this.syncDerivedSignals();
  }

  // ── read model ──────────────────────────────────────────────────────────

  /** Pre-serialized so the RPC boundary stays a plain string (the read model has deeply nested event details). */
  async stateJson(): Promise<string> {
    return JSON.stringify(this.readModel());
  }

  private readModel(): CoordinatorState {
    const forks = this.sql.exec<ForkRow>("SELECT * FROM forks ORDER BY created_at").toArray();
    const touched = this.sql.exec<{ fork: string; path: string; change: string; lines: number }>("SELECT * FROM touched").toArray();
    const symbolChanges = this.sql
      .exec<{ fork: string; path: string; name: string; kind: string; change: string; before_sig: string | null; after_sig: string | null }>("SELECT * FROM symbol_changes")
      .toArray();
    return {
      baseline: this.meta("baseline"),
      baselineHead: this.meta("baseline_head"),
      forks: forks.map((f) => ({
        ...f,
        files: touched.filter((t) => t.fork === f.name),
        symbols: symbolChanges.filter((s) => s.fork === f.name),
      })),
      overlaps: this.overlaps(),
      signals: this.sql
        .exec<SignalRow & { data: string }>("SELECT * FROM signals ORDER BY id DESC LIMIT 100")
        .toArray()
        .map((r) => ({ ...r, data: JSON.parse(r.data) as SignalData })),
      intents: this.sql
        .exec<{ id: number; fork: string; description: string; files: string; symbols: string; created_at: number }>("SELECT * FROM intents ORDER BY id")
        .toArray()
        .map((i) => ({ ...i, files: JSON.parse(i.files) as string[], symbols: JSON.parse(i.symbols) as string[] })),
      events: this.sql
        .exec<{ id: number; at: number; kind: string; fork: string | null; detail: string }>("SELECT * FROM event_log ORDER BY id DESC LIMIT 60")
        .toArray()
        .map((e) => ({ ...e, detail: JSON.parse(e.detail) as unknown })),
    };
  }
}

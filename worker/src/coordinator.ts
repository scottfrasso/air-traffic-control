import { DurableObject } from "cloudflare:workers";
import { forkName, headOf, type ForkIndex } from "./artifacts";
import { isPushed, type ArtifactsEvent } from "./events";
import { createPushSubscription, deletePushSubscription } from "./subscriptions";
import { SCHEMA } from "./schema";
import type { CoordinatorState, ForkCredentials, ForkRow, Overlap, PushSource } from "./types";

const RECONCILE_MS = 5_000;

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

    let subscriptionId: string | null = null;
    try {
      subscriptionId = await createPushSubscription(this.env, name);
    } catch (err) {
      this.log("subscription.failed", { error: (err as Error).message }, name);
    }

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

  override async alarm(): Promise<void> {
    await this.reconcile();
    if (this.activeForks().length > 0) await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
  }

  // ── teardown ────────────────────────────────────────────────────────────

  async abandonFork(name: string): Promise<void> {
    const fork = this.fork(name);
    if (!fork) return;
    this.sql.exec("UPDATE forks SET status = 'abandoned' WHERE name = ?", name);
    if (fork.subscription_id) await deletePushSubscription(this.env, fork.subscription_id).catch(() => undefined);
    this.log("fork.abandoned", {}, name);
  }

  // ── read model ──────────────────────────────────────────────────────────

  async state(): Promise<CoordinatorState> {
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
      events: this.sql
        .exec<{ id: number; at: number; kind: string; fork: string | null; detail: string }>("SELECT * FROM event_log ORDER BY id DESC LIMIT 60")
        .toArray()
        .map((e) => ({ ...e, detail: JSON.parse(e.detail) as unknown })),
    };
  }
}

import { DurableObject } from "cloudflare:workers";
import { forkName, headOf, type ForkIndex } from "./artifacts";
import { isPushed, type ArtifactsEvent } from "./events";
import { deletePushSubscription } from "./subscriptions";
import { checkerFor, type LandResult, type PairResult, type SingleResult } from "./checker";
import { approachQueue, isGreen, landingOrder } from "./landing";
import { buildSequence, clearanceMessage, prLabel, type Conflict, type SequenceEntry } from "./atc";
import { analyzePair, describeError } from "./conflicts";
import { SCHEMA } from "./schema";
import { DERIVED_KINDS, deriveSignals, intentConflicts, type DesiredSignal, type IndexSnapshot, type SignalKind } from "./signals";
import type { CoordinatorState, ForkCredentials, ForkRow, LandResponse, Overlap, PushSource, SignalData, SignalRow } from "./types";

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
    const at = Date.now();
    this.sql.exec("INSERT INTO event_log(at, kind, fork, detail) VALUES (?, ?, ?, ?)", at, kind, fork, JSON.stringify(detail));
    const id = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    this.deliverWebhooks({ id, at, kind, fork, pr: fork ? prLabel(fork) : null, detail });
    this.scheduleFlush();
  }

  // ── live push, recording, webhooks ──────────────────────────────────────

  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Coalesce bursts of events into one snapshot + one broadcast. */
  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.flush();
      } catch (err) {
        console.error("flush failed", err);
      }
    }, 120);
  }

  private flush() {
    if (!this.meta("baseline")) return;
    const model = this.readModel();
    const full = JSON.stringify(model);
    // Recording: compact snapshot for replay, stored only when the airspace actually changed.
    const compact = JSON.stringify({
      baseline: model.baseline,
      baselineHead: model.baselineHead,
      forks: model.forks.map(({ name, pr, status, landed_at, check_status, check_sha, head_sha, base_sha, diff_lines }) => ({ name, pr, status, landed_at, check_status, check_sha, head_sha, base_sha, diff_lines })),
      sequence: model.sequence,
      signals: model.signals
        .filter((x) => x.resolved_at === null && ["semantic_conflict", "merge_conflict", "rebase_required"].includes(x.kind))
        .map(({ kind, fork, about_fork, symbol }) => ({ kind, fork, about_fork, symbol, resolved_at: null })),
    });
    const last = this.sql.exec<{ state: string }>("SELECT state FROM snapshots ORDER BY id DESC LIMIT 1").toArray()[0]?.state;
    if (last !== compact) this.sql.exec("INSERT INTO snapshots(at, state) VALUES (?, ?)", Date.now(), compact);
    // Live push to every connected dashboard.
    for (const ws of this.ctx.getWebSockets("dashboard")) {
      try {
        ws.send(full);
      } catch {
        /* socket closing */
      }
    }
  }

  /** Dashboards connect here (Worker forwards the authorized upgrade request). */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["dashboard"]);
    if (this.meta("baseline")) server.send(JSON.stringify(this.readModel()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "state" && this.meta("baseline")) ws.send(JSON.stringify(this.readModel()));
  }

  /** Full recording for replay: every snapshot plus every event. */
  async timelineJson(): Promise<string> {
    const snapshots = this.sql.exec<{ at: number; state: string }>("SELECT at, state FROM snapshots ORDER BY id").toArray();
    const events = this.sql.exec<{ id: number; at: number; kind: string; fork: string | null; detail: string }>("SELECT * FROM event_log ORDER BY id").toArray();
    return `{"baseline":${JSON.stringify(this.meta("baseline"))},"snapshots":[${snapshots.map((x) => `{"at":${x.at},"state":${x.state}}`).join(",")}],"events":[${events
      .map((e) => JSON.stringify({ id: e.id, at: e.at, kind: e.kind, fork: e.fork, detail: JSON.parse(e.detail) as unknown }))
      .join(",")}]}`;
  }

  async addWebhook(url: string, secret: string | null): Promise<{ url: string }> {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("webhook URL must be https");
    this.sql.exec("INSERT INTO webhooks(url, secret, created_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET secret = excluded.secret", url, secret, Date.now());
    return { url };
  }

  async listWebhooks(): Promise<string[]> {
    return this.sql.exec<{ url: string }>("SELECT url FROM webhooks").toArray().map((r) => r.url);
  }

  async removeWebhook(url: string): Promise<void> {
    this.sql.exec("DELETE FROM webhooks WHERE url = ?", url);
  }

  private deliverWebhooks(event: { id: number; at: number; kind: string; fork: string | null; pr: string | null; detail: unknown }) {
    const hooks = this.sql.exec<{ url: string; secret: string | null }>("SELECT url, secret FROM webhooks").toArray();
    if (!hooks.length) return;
    const body = JSON.stringify({ type: "atc.event", baseline: this.meta("baseline"), event });
    for (const h of hooks) {
      this.ctx.waitUntil(
        (async () => {
          const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "atc-webhooks/1" };
          if (h.secret) {
            const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(h.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
            const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
            headers["x-atc-signature"] = `sha256=${[...sig].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
          }
          await fetch(h.url, { method: "POST", headers, body }).catch(() => undefined);
        })(),
      );
    }
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
    const pr = Number(this.meta("pr_seq") ?? 0) + 1;
    this.setMeta("pr_seq", String(pr));
    const name = forkName(baseline, pr);

    using base = await this.env.ARTIFACTS.get(baseline);
    const baseHead = (await base.log({ ref: "main", limit: 1 }))[0];
    if (!baseHead) throw new Error(`baseline ${baseline} has no commits`);
    const forked = await base.fork(name, { description: `agentmesh fork for ${agent}`, defaultBranchOnly: true });
    const baselineRead = await base.createToken("read", 6 * 3600);

    const subscriptionId: string | null = null; // attached by the Worker via attachSubscription (ADR-0009)

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO forks(name, agent, pr, status, created_at, base_sha, head_sha, processed_sha, subscription_id, remote)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET agent = excluded.agent, status = 'active', created_at = excluded.created_at,
         base_sha = excluded.base_sha, head_sha = excluded.head_sha, processed_sha = excluded.processed_sha,
         subscription_id = excluded.subscription_id, remote = excluded.remote, diff_lines = 0,
         land_requested_at = NULL, check_status = 'unknown', check_sha = NULL, check_detail = NULL`,
      name, agent, pr, now, baseHead.hash, baseHead.hash, baseHead.hash, subscriptionId, forked.remote,
    );
    this.log("fork.created", { agent, pr, baseSha: baseHead.hash }, name);
    await this.scheduleReconcile();

    return {
      fork: name,
      pr,
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
    if (index.baseSha === index.baselineHead) {
      this.resolveSignals({ fork: index.fork, kind: "rebase_required" });
      this.resolveSignals({ fork: index.fork, kind: "land_blocked" });
    }
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
  /** Agents and the dashboard talk in PR numbers: replace fork repo names with "PR<N>". */
  private relabel(text: string): string {
    const names = this.sql.exec<{ name: string }>("SELECT name FROM forks ORDER BY length(name) DESC").toArray().map((r) => r.name);
    return names.reduce((t, n) => t.split(n).join(prLabel(n)), text);
  }

  emitSignal(input: DesiredSignal): boolean {
    const s = { ...input, message: this.relabel(input.message) };
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

  // ── speculative checks (milestone 4) ───────────────────────────────────

  /** What the pipeline should check for a push: the other active forks to merge with. */
  async checkPlan(fork: string, sha: string): Promise<{ current: boolean; others: string[] }> {
    const row = this.fork(fork);
    if (!row || row.status !== "active" || row.head_sha !== sha) return { current: false, others: [] };
    return { current: true, others: this.activeForks().filter((f) => f.name !== fork && f.head_sha !== f.base_sha).map((f) => f.name) };
  }

  private setCheck(fork: string, sha: string, ok: boolean, detail: string) {
    const row = this.fork(fork);
    if (!row || row.head_sha !== sha) return; // stale result; a newer push is being checked
    this.sql.exec("UPDATE forks SET check_status = ?, check_sha = ?, check_detail = ? WHERE name = ?", ok ? "green" : "red", sha, detail, fork);
  }

  async applySingle(json: string): Promise<void> {
    const r = JSON.parse(json) as SingleResult;
    const detail = r.result.ok ? "typechecks" : r.result.errors.map(describeError).join("\n") || r.result.output.slice(0, 500);
    this.setCheck(r.repo, r.result.sha, r.result.ok, detail);
    this.log("check.single", { sha: r.result.sha, ok: r.result.ok, errors: r.result.errors.length }, r.repo);
  }

  /** Store a pair result; a merge-only typecheck failure becomes a semantic-conflict signal to both forks. */
  async applyPair(json: string): Promise<{ status: string }> {
    const r = JSON.parse(json) as PairResult;
    this.setCheck(r.a, r.aloneA.sha, r.aloneA.ok, r.aloneA.ok ? "typechecks" : r.aloneA.errors.map(describeError).join("\n"));
    this.setCheck(r.b, r.aloneB.sha, r.aloneB.ok, r.aloneB.ok ? "typechecks" : r.aloneB.errors.map(describeError).join("\n"));

    const a = this.fork(r.a);
    const b = this.fork(r.b);
    const fresh = a?.head_sha === r.aloneA.sha && b?.head_sha === r.aloneB.sha;
    const breaking: Record<string, string[]> = {};
    for (const row of this.sql
      .exec<{ fork: string; name: string }>("SELECT fork, name FROM symbol_changes WHERE change IN ('signature_changed', 'removed') AND fork IN (?, ?)", r.a, r.b)
      .toArray())
      breaking[row.fork] = [...(breaking[row.fork] ?? []), row.name];
    const v = analyzePair(r, breaking);

    const [x, y] = [r.a, r.b].sort() as [string, string];
    this.sql.exec(
      `INSERT INTO pair_checks(fork_a, fork_b, sha_a, sha_b, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fork_a, fork_b) DO UPDATE SET sha_a = excluded.sha_a, sha_b = excluded.sha_b, status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
      x, y, x === r.a ? r.aloneA.sha : r.aloneB.sha, x === r.a ? r.aloneB.sha : r.aloneA.sha, v.status,
      JSON.stringify({ newErrors: v.newErrors, symbol: v.symbol, changer: v.changer, conflicts: v.conflicts }), Date.now(),
    );
    this.log("check.pair", { a: r.a, b: r.b, status: v.status, fresh, symbol: v.symbol, errors: v.newErrors.map(describeError) }, null);
    if (!fresh) return { status: `${v.status} (stale)` };

    if (v.status === "clean" || v.status === "inherited_failure") {
      for (const [me, other] of [[r.a, r.b], [r.b, r.a]] as const) {
        this.resolveSignals({ fork: me, kind: "semantic_conflict", about_fork: other });
        this.resolveSignals({ fork: me, kind: "merge_conflict", about_fork: other });
      }
    } else if (v.status === "textual_conflict") {
      for (const [me, other] of [[r.a, r.b], [r.b, r.a]] as const)
        this.emitSignal({
          fork: me, kind: "merge_conflict", about_fork: other, symbol: null,
          message: `Your fork and ${other} conflict textually in ${v.conflicts.join(", ")}.`,
          data: { files: v.conflicts }, dedupe_key: `merge:${me}:${other}:${v.conflicts.join(",")}`,
        });
    } else {
      const first = v.newErrors[0];
      const where = first ? describeError(first) : "typecheck fails";
      const errorKey = v.newErrors.map((e) => `${e.file}:${e.code}`).join(",");
      for (const [me, other] of [[r.a, r.b], [r.b, r.a]] as const) {
        let why = "";
        if (v.symbol && v.changer && v.user) {
          why = me === v.user
            ? ` ${other} changed ${v.symbol}, and your ${first?.file ?? "code"} still uses the old shape.`
            : ` ${other} uses ${v.symbol}, which you changed, in ${first?.file ?? "its code"}.`;
        }
        this.emitSignal({
          fork: me, kind: "semantic_conflict", about_fork: other, symbol: v.symbol,
          message: `Speculative merge with ${other} merges cleanly but fails typecheck: ${where}.${why} Neither fork fails alone.`,
          data: { errors: v.newErrors.map(describeError), changer: v.changer, user: v.user },
          dedupe_key: `semantic:${me}:${other}:${v.symbol ?? ""}:${errorKey}`,
        });
      }
    }
    return { status: v.status };
  }

  // ── ATC sequence ────────────────────────────────────────────────────────

  private conflictMap(): Map<string, Conflict[]> {
    const m = new Map<string, Conflict[]>();
    for (const r of this.sql
      .exec<{ fork: string; about_fork: string; symbol: string | null }>(
        "SELECT fork, about_fork, symbol FROM signals WHERE kind IN ('semantic_conflict', 'merge_conflict') AND resolved_at IS NULL AND about_fork IS NOT NULL",
      )
      .toArray())
      m.set(r.fork, [...(m.get(r.fork) ?? []), { other: r.about_fork, symbol: r.symbol }]);
    return m;
  }

  sequence(): SequenceEntry[] {
    return buildSequence(this.activeForks(), this.conflictMap(), this.meta("baseline_head") ?? "");
  }

  /** What ATC tells one PR: its place in the landing sequence and why. */
  async getClearance(fork: string): Promise<{ fork: string; pr: string; position: number | null; clearance: string; message: string }> {
    const row = this.fork(fork);
    if (!row) return { fork, pr: prLabel(fork), position: null, clearance: "unknown", message: `ATC: ${prLabel(fork)} is not in this airspace.` };
    if (row.status === "landed") return { fork, pr: prLabel(fork), position: null, clearance: "landed", message: `ATC: ${prLabel(fork)} has landed.` };
    const e = this.sequence().find((x) => x.fork === fork);
    if (!e) return { fork, pr: prLabel(fork), position: null, clearance: row.status, message: `ATC: ${prLabel(fork)} is ${row.status}.` };
    return { fork, pr: e.pr, position: e.position, clearance: e.clearance, message: clearanceMessage(e) };
  }

  // ── landing gate (milestone 5) ─────────────────────────────────────────

  /** Open conflicts (semantic or textual) between `fork` and other active forks. */
  private rivals(fork: string): ForkRow[] {
    const names = this.sql
      .exec<{ about_fork: string }>(
        "SELECT DISTINCT about_fork FROM signals WHERE fork = ? AND kind IN ('semantic_conflict', 'merge_conflict') AND resolved_at IS NULL AND about_fork IS NOT NULL",
        fork,
      )
      .toArray()
      .map((r) => r.about_fork);
    return names.map((n) => this.fork(n)).filter((f): f is ForkRow => f?.status === "active");
  }

  /**
   * Merge `fork` into baseline only if it is current and green. If it conflicts with another fork that is
   * closer to landing (ADR-0011), it yields. On landing, conflicting forks get "rebase required".
   */
  async requestLand(fork: string): Promise<LandResponse> {
    const row = this.fork(fork);
    if (!row || row.status !== "active") return { landed: false, fork, reason: `unknown or inactive fork ${fork}` };
    // An agent typically pushes and immediately asks to land: pick up a push we haven't seen yet.
    const liveFork = await headOf(this.env, fork);
    if (liveFork && liveFork.hash !== row.head_sha) {
      await this.onPush(fork, liveFork.hash, "reconcile");
      return { landed: false, fork, reason: "Picked up your latest push; checks are running. Retry in a few seconds.", retry: true };
    }
    if (row.land_requested_at === null) this.sql.exec("UPDATE forks SET land_requested_at = ? WHERE name = ?", Date.now(), fork);
    this.log("land.requested", { head: row.head_sha }, fork);

    const baseline = this.baseline;
    const live = await headOf(this.env, baseline);
    if (live && live.hash !== this.meta("baseline_head")) this.setMeta("baseline_head", live.hash);
    const baselineHead = this.meta("baseline_head") ?? "";
    const me = this.fork(fork)!;

    const deny = (raw: string, kind: SignalKind | null = "land_blocked"): LandResponse => {
      const reason = this.relabel(raw);
      this.log("land.denied", { reason }, fork);
      if (kind)
        this.emitSignal({ fork, kind, about_fork: null, symbol: null, message: reason, data: { baselineHead }, dedupe_key: `${kind}:${fork}:${me.head_sha}:${baselineHead}:${reason.slice(0, 40)}` });
      return { landed: false, fork, reason, baselineHead, atc: this.sequence().find((e) => e.fork === fork) ? clearanceMessage(this.sequence().find((e) => e.fork === fork)!) : undefined };
    };

    // base_sha is only known once the push is indexed, so "still checking" must be answered first.
    if (me.processed_sha !== me.head_sha || me.check_status === "pending" || me.check_sha !== me.head_sha)
      return { landed: false, fork, reason: "Checks for your latest push are still running; retry in a few seconds.", baselineHead, retry: true };
    if (me.base_sha !== baselineHead) return deny(`Baseline has moved to ${baselineHead.slice(0, 7)}; rebase onto it and push before landing.`, "rebase_required");
    if (!isGreen(me)) return deny(`Your fork does not typecheck at ${me.head_sha.slice(0, 7)}: ${me.check_detail ?? ""}`.trim());

    const ahead = this.rivals(fork).filter((r) => landingOrder(r, me, baselineHead) < 0);
    if (ahead.length) {
      const r = ahead[0]!;
      return deny(`${r.name} conflicts with your fork and is closer to landing (it ${r.land_requested_at ? "already requested landing" : "is ahead"}${r.diff_lines < me.diff_lines ? " and has a smaller diff" : ""}). Wait for it to land, then rebase.`);
    }

    if (this.meta("landing") && Number(this.meta("landing")) > Date.now() - 120_000) return { landed: false, fork, reason: "Another landing is in progress; retry shortly.", baselineHead, retry: true };
    this.setMeta("landing", String(Date.now()));
    try {
      const [forkRef, baseRef] = await Promise.all([this.repoRef(fork, "read"), this.repoRef(baseline, "write")]);
      const result = JSON.parse(
        await checkerFor(this.env, baseline, "land").run({ mode: "land", fork: forkRef, baseline: { ...baseRef, expectedHead: baselineHead } }),
      ) as LandResult & { error?: string };
      if (result.error) return deny(`Landing failed: ${result.error}`);
      if (!result.landed || !result.forkHead) return deny(result.reason ?? "landing refused", result.reason?.includes("rebase") ? "rebase_required" : "land_blocked");
      return this.onLanded(me, result.forkHead, baselineHead);
    } finally {
      this.setMeta("landing", "");
    }
  }

  private async repoRef(repo: string, scope: "read" | "write") {
    using handle = await this.env.ARTIFACTS.get(repo);
    const [token, info] = await Promise.all([handle.createToken(scope, 600), handle.info()]);
    return { name: repo, remote: info.remote, token: token.plaintext };
  }

  private async onLanded(winner: ForkRow, newHead: string, previousHead: string): Promise<LandResponse> {
    const now = Date.now();
    this.setMeta("baseline_head", newHead);
    this.sql.exec("UPDATE forks SET status = 'landed', landed_at = ? WHERE name = ?", now, winner.name);
    this.log("land.merged", { head: newHead, previousHead, diffLines: winner.diff_lines }, winner.name);
    if (winner.subscription_id) await deletePushSubscription(this.env, winner.subscription_id).catch(() => undefined);

    const conflicted = new Set(this.rivals(winner.name).map((r) => r.name));
    this.resolveSignals({ fork: winner.name });
    const told: string[] = [];
    for (const other of this.activeForks()) {
      const sem = this.sql
        .exec<{ symbol: string | null; message: string }>(
          "SELECT symbol, message FROM signals WHERE fork = ? AND about_fork = ? AND kind IN ('semantic_conflict', 'merge_conflict') AND resolved_at IS NULL",
          other.name, winner.name,
        )
        .toArray()[0];
      this.resolveSignals({ fork: other.name, about_fork: winner.name });
      const conflict = conflicted.has(other.name);
      this.emitSignal({
        fork: other.name,
        kind: "rebase_required",
        about_fork: winner.name,
        symbol: sem?.symbol ?? null,
        message: conflict
          ? `${winner.name} landed (baseline is now ${newHead.slice(0, 7)}). Your fork conflicts with it${sem?.symbol ? ` on ${sem.symbol}` : ""}: rebase onto baseline main and fix before landing. ${sem ? `Earlier finding: ${sem.message}` : ""}`.trim()
          : `${winner.name} landed (baseline is now ${newHead.slice(0, 7)}). Rebase onto baseline main before landing.`,
        data: { newHead, conflict },
        dedupe_key: `rebase:${other.name}:${newHead}`,
      });
      told.push(other.name);
    }
    this.emitSignal({
      fork: winner.name, kind: "landed", about_fork: null, symbol: null,
      message: `Landed at ${newHead.slice(0, 7)}.${told.length ? ` Told ${told.join(", ")} to rebase.` : ""}`,
      data: { newHead }, dedupe_key: `landed:${winner.name}:${newHead}`,
    });
    this.syncDerivedSignals();
    return { landed: true, fork: winner.name, baselineHead: newHead, previousHead, rebaseRequired: told };
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
      approach: approachQueue(this.activeForks(), this.meta("baseline_head") ?? ""),
      sequence: this.sequence(),
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

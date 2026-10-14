import { DurableObject } from "cloudflare:workers";
import { forkName, headOf, type ForkIndex } from "./artifacts";
import { isPushed, type ArtifactsEvent } from "./events";
import { deletePushSubscription } from "./subscriptions";
import { checkerFor, type LandResult, type NotesResult, type PairResult, type SingleResult } from "./checker";
import {
  approachQueue, checkRetriesLeft, forksToRecheck, forksWaitingOnPairs, isDuplicateInstance, landGate, stuckCheck, type CheckRun, mayRelease, outstandingPairs, pairFailure, pairPartners, pairResultRow, pairsToQueue, parseLock, queuedPair,
  takeLock, type PairCheckRow, type PairQueueRow,
} from "./landing";
import { buildSequence, clearanceMessage, prLabel, type Conflict, type SequenceEntry } from "./atc";
import { analyzePair, describeError } from "./conflicts";
import { NoteWriter, takeBatch } from "./notes";
import { clearanceHistory, flightLogNote, minimalFlightLog, type FlightSignal, type SequenceSnapshot } from "./flightlog";
import { computeSavings, type LogEvent } from "./savings";
import { SCHEMA } from "./schema";
import { DERIVED_KINDS, deriveSignals, intentConflicts, type DesiredSignal, type IndexSnapshot, type SignalKind } from "./signals";
import type { CoordinatorState, FlightLogEntry, ForkCredentials, ForkRow, LandResponse, Overlap, PushSource, SignalData, SignalRow } from "./types";

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
      savings: model.savings, // flight logs never change once written: the timeline carries them once

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
    return `{"baseline":${JSON.stringify(this.meta("baseline"))},"flightLogs":${JSON.stringify(this.flightLogs())},"snapshots":[${snapshots.map((x) => `{"at":${x.at},"state":${x.state}}`).join(",")}],"events":[${events
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
      await this.baselineMoved(sha, source);
      return;
    }
    const fork = this.fork(repo);
    if (!fork || fork.status !== "active") {
      this.log("push.ignored", { repo, sha, source, reason: "unknown or inactive fork" }, repo);
      return;
    }
    if (fork.head_sha === sha) return;
    this.sql.exec("UPDATE forks SET head_sha = ?, check_status = 'pending' WHERE name = ?", sha, repo);
    this.sql.exec("INSERT INTO head_seen(fork, sha, at) VALUES (?, ?, ?) ON CONFLICT(fork) DO UPDATE SET sha = excluded.sha, at = excluded.at", repo, sha, Date.now());
    this.log("push.received", { sha, source, commits: isPushed(event) ? event.payload.commits.map((c) => c.message) : undefined }, repo);
    // A new push is a fresh attempt: drop any go-around/blocked notes; the checks on this push decide.
    this.resolveSignals({ fork: repo, kind: "rebase_required" });
    this.resolveSignals({ fork: repo, kind: "land_blocked" });
    this.resolveSignals({ fork: repo, kind: "check_failed" });
    this.resolveSignals({ about_fork: repo, kind: "check_failed" });
    await this.startPipeline(repo, sha);
  }

  /**
   * Main moved outside a landing ATC made (someone pushed to main, or ATC learned of it late). Every PR checked on
   * the old main is re-checked on the new one; without this, a check that ran on the old main is dropped as stale
   * and the PR stays pending forever (issue #2).
   */
  private async baselineMoved(sha: string, source: PushSource) {
    if (this.meta("baseline_head") === sha) return;
    this.setMeta("baseline_head", sha);
    this.log("baseline.pushed", { sha, source });
    await this.recheckAll(new Set());
  }

  /**
   * kind "push": full pipeline (index, overlap signals, PR-on-main check, pair merges).
   * kind "recheck": main moved; only re-verify that the PR still merges onto the new main and typechecks.
   * kind "pairs": a pair check was lost or went stale; re-run just those pairs at the current heads.
   */
  /** Returns false if the instance couldn't be created (usually: the same push was already started). */
  /** `restart`: the n-th time ATC starts this PR's checks again by itself (a new instance id, see restartStuckChecks). */
  private async startPipeline(fork: string, sha: string, kind: "push" | "recheck" | "pairs" = "push", others: Array<{ name: string; sha: string }> = [], restart = 0): Promise<boolean> {
    const main = this.meta("baseline_head") ?? "";
    const raw =
      kind === "pairs"
        ? `p${Date.now()}-${sha.slice(0, 12)}-${others.map((o) => o.sha.slice(0, 12)).join("-")}-${fork}` // unique part first: ids are cut at 100 chars
        : `${fork}-${sha.slice(0, 12)}${kind === "recheck" ? `-m${main.slice(0, 10)}` : ""}${restart ? `-r${restart}` : ""}`;
    const id = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
    if (kind !== "pairs") {
      // Recorded even if the start fails below, so the reconcile alarm tries again later instead of never.
      this.sql.exec(
        `INSERT INTO check_runs(fork, sha, started_at, restarts) VALUES (?, ?, ?, ?)
         ON CONFLICT(fork) DO UPDATE SET started_at = excluded.started_at,
           restarts = CASE WHEN check_runs.sha = excluded.sha THEN max(check_runs.restarts, excluded.restarts) ELSE excluded.restarts END, sha = excluded.sha`,
        fork, sha, Date.now(), restart,
      );
    }
    try {
      await this.env.PUSH_PIPELINE.create({ id, params: { baseline: this.baseline, fork, sha, kind, others } });
      this.log("pipeline.started", { sha, instance: id }, fork);
      return true;
    } catch (err) {
      const error = (err as Error).message;
      // Same push seen twice (event + reconcile, or queue redelivery) → instance already exists. Anything else is real.
      if (isDuplicateInstance(error)) this.log("pipeline.duplicate", { sha, instance: id }, fork);
      else this.log("pipeline.start_failed", { sha, instance: id, kind, error: error.slice(0, 300) }, fork);
      return false;
    }
  }

  /** The Workflow for this push (or re-check) failed for good. Show it as an error, not as pending forever (issue #2). */
  async applyPipelineFailure(fork: string, sha: string, error: string): Promise<void> {
    const row = this.fork(fork);
    this.log("pipeline.failed", { sha, error: error.slice(0, 300), current: row?.head_sha === sha }, fork);
    if (!row || row.status !== "active" || row.head_sha !== sha) return; // a newer push has its own pipeline
    if (row.check_sha === sha && (row.check_status === "green" || row.check_status === "red")) return; // a duplicate run already has a result
    this.sql.exec("UPDATE forks SET check_status = 'error', check_sha = ?, check_detail = ? WHERE name = ?", sha, error.slice(0, 500), fork);
    this.emitSignal({
      fork, kind: "check_failed", about_fork: null, symbol: null,
      message: `ATC couldn't run the checks on your push ${sha.slice(0, 7)} (${error.slice(0, 120)}). It retries by itself; you can also push again.`,
      data: { error: error.slice(0, 500) }, dedupe_key: `check_failed:${fork}:${sha}`,
    });
    this.touch();
    await this.scheduleReconcile();
  }

  /** From the reconcile alarm: start checks again that errored or have been pending too long; give up after a few tries. */
  private async restartStuckChecks() {
    const runs = new Map(this.sql.exec<CheckRun>("SELECT * FROM check_runs").toArray().map((r) => [r.fork, r]));
    const head = this.meta("baseline_head") ?? "";
    for (const f of this.activeForks()) {
      const s = stuckCheck(f, runs.get(f.name), head, Date.now());
      if (!s) continue;
      if ("giveUp" in s) {
        this.log("check.gave_up", { sha: f.head_sha }, f.name);
        await this.applyPipelineFailure(f.name, f.head_sha, "checks didn't finish after several tries");
        continue;
      }
      this.log("check.restarted", { sha: f.head_sha, kind: s.restart, attempt: s.attempt }, f.name);
      // Pending again (not "error"), so this run gets the full CHECK_STUCK_MS before it counts as stuck.
      this.sql.exec("UPDATE forks SET check_status = 'pending' WHERE name = ?", f.name);
      this.touch(); // keep the alarm running until this run reports back
      await this.startPipeline(f.name, f.head_sha, s.restart, [], s.attempt);
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
    });
    // The index's view of main is never written back as the global head (issue #4): one computed before a landing and
    // applied after it would move baseline_head backwards. Only a push to main, a land request and onLanded set it.
    // A newer main the index saw first is picked up by the reconcile alarm within seconds.
    const main = this.meta("baseline_head");
    this.log("index.updated", { sha: index.headSha, base: index.baseSha, files: index.files.map((f) => f.path), diffLines: index.diffLines, sawMain: index.baselineHead, main }, index.fork);
    // Sits on the CURRENT main: a go-around or block from an earlier main no longer applies. (Comparing with the
    // index's own, possibly older, main would clear a go-around that a landing sent while this index was computed.)
    if (index.baseSha === main) {
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
  async checkPlan(fork: string, sha: string): Promise<{ current: boolean; others: Array<{ name: string; sha: string }> }> {
    const forks = this.activeForks();
    const others = pairPartners(forks, fork, sha);
    if (!others) return { current: false, others: [] };
    const me = forks.find((f) => f.name === fork)!;
    for (const o of others) this.markPairQueued(me, o);
    return { current: true, others: others.map((f) => ({ name: f.name, sha: f.head_sha })) };
  }

  private markPairQueued(x: ForkRow, y: ForkRow) {
    const q = queuedPair(x, y, Date.now());
    this.sql.exec(
      `INSERT INTO pair_queue(fork_a, fork_b, sha_a, sha_b, queued_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fork_a, fork_b) DO UPDATE SET sha_a = excluded.sha_a, sha_b = excluded.sha_b, queued_at = excluded.queued_at`,
      q.fork_a, q.fork_b, q.sha_a, q.sha_b, q.queued_at,
    );
  }

  private pairChecks() {
    return this.sql.exec<PairCheckRow>("SELECT fork_a, fork_b, sha_a, sha_b, status, detail, checked_at FROM pair_checks").toArray();
  }

  private savePairCheck(c: PairCheckRow) {
    this.sql.exec(
      `INSERT INTO pair_checks(fork_a, fork_b, sha_a, sha_b, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fork_a, fork_b) DO UPDATE SET sha_a = excluded.sha_a, sha_b = excluded.sha_b, status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
      c.fork_a, c.fork_b, c.sha_a, c.sha_b, c.status ?? "error", c.detail ?? "{}", c.checked_at ?? Date.now(),
    );
  }

  /** Pairs of active PRs whose current heads have no final speculative-merge result yet (issue #5). */
  private outstandingPairs() {
    return outstandingPairs(this.activeForks(), this.pairChecks());
  }

  /** Re-queue pair checks that are missing or stale (a result was dropped as not current, or a check was lost). */
  private async requeuePairs() {
    const queue = this.sql.exec<PairQueueRow>("SELECT * FROM pair_queue").toArray();
    const seen = new Map(this.sql.exec<{ fork: string; sha: string; at: number }>("SELECT * FROM head_seen").toArray().map((r) => [r.fork, r]));
    const indexing = new Map(
      this.activeForks()
        .filter((f) => f.processed_sha !== f.head_sha)
        .map((f) => [f.name, seen.get(f.name)?.sha === f.head_sha ? seen.get(f.name)!.at : 0] as const),
    );
    const due = pairsToQueue(this.outstandingPairs(), queue, Date.now(), indexing);
    // Mark every due pair before the first await, so an interleaved requeue doesn't start any of them twice.
    for (const need of due) this.markPairQueued(this.fork(need.a)!, this.fork(need.b)!);
    for (const need of due) {
      const prev = queue.find((q) => q.fork_a === need.a && q.fork_b === need.b);
      const reason = need.failedAt !== undefined ? "retry after error" : indexing.has(need.a) || indexing.has(need.b) ? "indexing stuck" : prev ? "stale or lost" : "never checked";
      this.log("check.pair.requeued", { a: need.a, b: need.b, reason }, null);
      if (!(await this.startPipeline(need.a, need.shaA, "pairs", [{ name: need.b, sha: need.shaB }])))
        this.sql.exec("DELETE FROM pair_queue WHERE fork_a = ? AND fork_b = ? AND sha_a = ? AND sha_b = ?", need.a, need.b, need.shaA, need.shaB);
    }
  }

  private setCheck(fork: string, sha: string, ok: boolean, detail: string, base: string | null) {
    const row = this.fork(fork);
    if (!row || row.head_sha !== sha) return; // stale result; a newer push is being checked
    this.sql.exec("UPDATE forks SET check_status = ?, check_sha = ?, check_base = ?, check_detail = ? WHERE name = ?", ok ? "green" : "red", sha, base, detail, fork);
  }

  /** Result of "this PR merged onto current main typechecks?" — the PR's green/red status. */
  async applySingle(json: string): Promise<void> {
    const r = JSON.parse(json) as SingleResult;
    const errs = r.result.errors.map(describeError).join("\n") || r.result.output.slice(0, 500);
    const detail = r.result.ok ? "merges onto main and typechecks" : r.mainConflict ? `on main: ${errs}` : errs;
    if (r.baseHead && r.baseHead !== this.meta("baseline_head")) {
      this.log("check.single.stale", { checkedOn: r.baseHead, timings: r.timings ?? [] }, r.repo); // main moved during the check; a recheck follows
      return;
    }
    this.setCheck(r.repo, r.forkSha, r.result.ok, detail, r.baseHead);
    this.log("check.single", { sha: r.forkSha, ok: r.result.ok, onMain: r.baseHead, mainConflict: !!r.mainConflict, errors: r.result.errors.length, timings: r.timings ?? [] }, r.repo);
  }

  /** Main moved: re-verify every waiting PR against the new main (no rebase needed unless it no longer fits). */
  private async recheckAll(except: Set<string>) {
    for (const f of forksToRecheck(this.activeForks(), this.meta("baseline_head") ?? "", except)) {
      this.sql.exec("UPDATE forks SET check_status = 'pending' WHERE name = ?", f.name);
      await this.startPipeline(f.name, f.head_sha, "recheck");
    }
  }

  /** Store a pair result; a merge-only typecheck failure becomes a semantic-conflict signal to both forks. */
  async applyPair(json: string): Promise<{ status: string }> {
    const r = JSON.parse(json) as PairResult & { error?: string };
    if (r.error) throw new Error(`pair check failed: ${r.error}`); // the step retries; after that, applyPairFailure

    const breaking: Record<string, string[]> = {};
    for (const row of this.sql
      .exec<{ fork: string; name: string }>("SELECT fork, name FROM symbol_changes WHERE change IN ('signature_changed', 'removed') AND fork IN (?, ?)", r.a, r.b)
      .toArray())
      breaking[row.fork] = [...(breaking[row.fork] ?? []), row.name];
    const v = analyzePair(r, breaking);

    const row = pairResultRow(
      this.activeForks(), r.a, r.aloneA.sha, r.b, r.aloneB.sha, v.status,
      JSON.stringify({ newErrors: v.newErrors, symbol: v.symbol, changer: v.changer, conflicts: v.conflicts }), Date.now(),
    );
    this.log("check.pair", { a: r.a, b: r.b, status: v.status, fresh: !!row, symbol: v.symbol, errors: v.newErrors.map(describeError), timings: r.timings ?? [] }, null);
    if (!row) {
      // Not for both PRs' current heads: recording it would overwrite a newer result, or mark a push ATC hasn't
      // seen yet as checked without raising its conflicts. Drop it and make sure the current heads get checked.
      await this.requeuePairs();
      return { status: `${v.status} (stale)` };
    }
    this.savePairCheck(row);
    for (const [me, other] of [[r.a, r.b], [r.b, r.a]] as const) this.resolveSignals({ fork: me, kind: "check_failed", about_fork: other });

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

  /**
   * A pair check that kept failing (container error, timeout) after its step retries. It stays outstanding, so neither
   * PR is cleared, and the reconcile alarm runs it again after a back-off. Once PAIR_MAX_ATTEMPTS attempts have failed
   * it counts as checked, so a broken checker can't block landing forever, and both PRs are told. The land-time
   * typecheck on main still catches a real conflict.
   */
  async applyPairFailure(a: string, shaA: string, b: string, shaB: string, error: string): Promise<void> {
    const outcome = pairFailure(this.activeForks(), this.pairChecks(), a, shaA, b, shaB, error, Date.now());
    this.log("check.pair.failed", { a, b, shaA, shaB, error: error.slice(0, 300), ...(outcome.record ? { attempt: outcome.attempts, final: outcome.final } : { dropped: outcome.why }) }, null);
    if (!outcome.record) return; // heads moved (a newer push re-queues it), or a real result is already in
    this.savePairCheck(outcome.row);
    if (!outcome.final) {
      // The retry runs from the reconcile alarm: keep it running even if no agent is calling the API right now.
      this.touch();
      await this.scheduleReconcile();
      return;
    }
    for (const [me, other] of [[a, b], [b, a]] as const)
      this.emitSignal({
        fork: me, kind: "check_failed", about_fork: other, symbol: null,
        message: `ATC couldn't check your PR against ${other} (${error.slice(0, 120)}). Landing isn't blocked on it; the typecheck on main at landing still applies.`,
        data: { error: error.slice(0, 500) }, dedupe_key: `check_failed:${me}:${other}:${shaA}:${shaB}`,
      });
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

  /** PRs that must go around: they conflict with something that already landed. */
  private goAroundMap(): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of this.sql
      .exec<{ fork: string; about_fork: string | null; symbol: string | null; message: string }>(
        "SELECT fork, about_fork, symbol, message FROM signals WHERE kind = 'rebase_required' AND resolved_at IS NULL",
      )
      .toArray())
      m.set(
        r.fork,
        r.about_fork
          ? `Conflicts with ${prLabel(r.about_fork)} (landed)${r.symbol ? ` on ${r.symbol}` : ""}. Rebase onto main and fix.`
          : r.message.length > 220 ? `${r.message.slice(0, 217)}...` : r.message,
      );
    return m;
  }

  sequence(): SequenceEntry[] {
    return buildSequence(this.activeForks(), this.conflictMap(), this.meta("baseline_head") ?? "", this.goAroundMap(), forksWaitingOnPairs(this.outstandingPairs()));
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
    if (live) await this.baselineMoved(live.hash, "land");
    const baselineHead = this.meta("baseline_head") ?? "";
    const me = this.fork(fork)!;

    const deny = (raw: string, kind: SignalKind | null = "land_blocked"): LandResponse => {
      const reason = this.relabel(raw);
      this.log("land.denied", { reason }, fork);
      if (kind)
        this.emitSignal({ fork, kind, about_fork: null, symbol: null, message: reason, data: { baselineHead }, dedupe_key: `${kind}:${fork}:${me.head_sha}:${baselineHead}:${reason.slice(0, 40)}` });
      return { landed: false, fork, reason, baselineHead, atc: this.sequence().find((e) => e.fork === fork) ? clearanceMessage(this.sequence().find((e) => e.fork === fork)!) : undefined };
    };

    const gate = landGate({
      me, baselineHead, goAround: this.goAroundMap().get(fork), waitingOnPairs: forksWaitingOnPairs(this.outstandingPairs()).has(fork), rivals: this.rivals(fork),
      checkRetriesLeft: checkRetriesLeft(me, this.sql.exec<CheckRun>("SELECT * FROM check_runs WHERE fork = ?", fork).toArray()[0]),
    });
    if (gate.kind === "deny") return deny(gate.reason, gate.signal);
    if (gate.kind === "retry") {
      if (gate.then === "recheck") {
        this.sql.exec("UPDATE forks SET check_status = 'pending' WHERE name = ?", fork);
        await this.startPipeline(fork, me.head_sha, "recheck");
      } else if (gate.then === "requeue_pairs") await this.requeuePairs();
      return { landed: false, fork, reason: gate.reason, baselineHead, retry: true };
    }

    // One landing at a time (issue #3): a token so a landing that outlived its lock can't release someone else's.
    const token = crypto.randomUUID();
    const lock = takeLock(parseLock(this.meta("landing")), Date.now(), token);
    if (!lock) return { landed: false, fork, reason: "Another landing is in progress; retry shortly.", baselineHead, retry: true };
    this.setMeta("landing", JSON.stringify(lock));
    try {
      const [forkRef, baseRef] = await Promise.all([this.repoRef(fork, "read"), this.repoRef(baseline, "write")]);
      // The story up to the moment it lands. A bug in building it must never fail a landing: fall back to the basics.
      let note: string;
      try {
        note = this.flightLogNote(me, baselineHead, true);
      } catch (err) {
        this.log("notes.build_failed", { error: (err as Error).message.slice(0, 300) }, fork);
        note = minimalFlightLog(me.name, me.agent, baselineHead);
      }
      // Pin both heads (issue #1): land exactly the fork commit ATC checked, onto exactly the main it was checked on.
      const result = JSON.parse(
        await checkerFor(this.env, baseline, "land").run({
          mode: "land", fork: { ...forkRef, expectedHead: me.head_sha }, baseline: { ...baseRef, expectedHead: baselineHead },
        }),
      ) as LandResult & { error?: string };
      if (result.error) return deny(`Landing failed: ${result.error}`);
      if (result.retry) return { landed: false, fork, reason: result.reason ?? "retry", baselineHead, retry: true };
      if (!result.landed || !result.landedSha) {
        const firstError = result.typecheck?.errors[0];
        const where = firstError ? `: ${describeError(firstError)}` : "";
        return deny(`Doesn't fit on current main (${result.reason ?? "landing refused"}${where}). Rebase onto main and fix.`, result.mainConflict ? "rebase_required" : "land_blocked");
      }
      const landed = await this.onLanded(me, result.landedSha, baselineHead, !!result.merged, note);
      this.ctx.waitUntil(this.writeNotes()); // after the landing is recorded; the agent doesn't wait on git notes
      return landed;
    } finally {
      if (mayRelease(parseLock(this.meta("landing")), token)) this.setMeta("landing", "");
    }
  }

  private async repoRef(repo: string, scope: "read" | "write") {
    using handle = await this.env.ARTIFACTS.get(repo);
    const [token, info] = await Promise.all([handle.createToken(scope, 600), handle.info()]);
    return { name: repo, remote: info.remote, token: token.plaintext };
  }

  /**
   * After a landing: announce it to everyone. Only PRs with an open conflict against the winner must go around;
   * the rest stay in line and are automatically re-checked on the new main (ATC merges them when they land).
   */
  private async onLanded(winner: ForkRow, newHead: string, previousHead: string, merged: boolean, note: string): Promise<LandResponse> {
    const now = Date.now();
    this.setMeta("baseline_head", newHead);
    this.sql.exec("UPDATE forks SET status = 'landed', landed_at = ? WHERE name = ?", now, winner.name);
    this.sql.exec(
      "INSERT OR REPLACE INTO flight_logs(fork, landed_sha, landed_at, note, noted, note_error) VALUES (?, ?, ?, ?, 0, NULL)",
      winner.name, newHead, now, note,
    );
    this.log("land.merged", { head: newHead, previousHead, diffLines: winner.diff_lines, mergedByATC: merged }, winner.name);
    if (winner.subscription_id) await deletePushSubscription(this.env, winner.subscription_id).catch(() => undefined);

    this.resolveSignals({ fork: winner.name });
    const goAround: string[] = [];
    for (const other of this.activeForks()) {
      const sem = this.sql
        .exec<{ symbol: string | null; message: string }>(
          "SELECT symbol, message FROM signals WHERE fork = ? AND about_fork = ? AND kind IN ('semantic_conflict', 'merge_conflict') AND resolved_at IS NULL",
          other.name, winner.name,
        )
        .toArray()[0];
      this.resolveSignals({ fork: other.name, about_fork: winner.name });
      if (sem) {
        goAround.push(other.name);
        this.emitSignal({
          fork: other.name, kind: "rebase_required", about_fork: winner.name, symbol: sem.symbol,
          message: `${winner.name} landed (main is now ${newHead.slice(0, 7)}) and your PR conflicts with it${sem.symbol ? ` on ${sem.symbol}` : ""}. Go around: rebase onto main, fix, push. Finding: ${sem.message}`,
          data: { newHead }, dedupe_key: `rebase:${other.name}:${newHead}`,
        });
      } else {
        this.emitSignal({
          fork: other.name, kind: "landed", about_fork: winner.name, symbol: null,
          message: `${winner.name} landed (main is now ${newHead.slice(0, 7)}). No conflict with your PR: stay in line, no rebase needed. ATC is re-checking your PR on the new main.`,
          data: { newHead }, dedupe_key: `landed-ahead:${other.name}:${newHead}`,
        });
      }
    }
    this.emitSignal({
      fork: winner.name, kind: "landed", about_fork: null, symbol: null,
      message: `Landed at ${newHead.slice(0, 7)}.${goAround.length ? ` ${goAround.join(", ")} must go around (conflict).` : ""}`,
      data: { newHead }, dedupe_key: `landed:${winner.name}:${newHead}`,
    });
    this.syncDerivedSignals();
    await this.recheckAll(new Set(goAround));
    return {
      landed: true,
      fork: winner.name,
      baselineHead: newHead,
      previousHead,
      rebaseRequired: goAround,
      atc: `ATC: ${prLabel(winner.name)}, landed at ${newHead.slice(0, 7)}${merged ? " (merged onto main by ATC)" : ""}.${goAround.length ? ` ${goAround.map(prLabel).join(", ")} must go around.` : " No one has to go around."}`,
    };
  }

  // ── flight log (context preservation, ADR-0019) ─────────────────────────

  private notesPending(): boolean {
    return this.sql.exec("SELECT 1 FROM flight_logs WHERE noted = 0 LIMIT 1").toArray().length > 0;
  }

  /**
   * Write every flight log not yet in git (this landing's, plus any that failed before). One writer per Coordinator, so
   * two notes pushes never race; a call while one runs makes it go round again. Retries with backoff; the reconcile
   * alarm picks up anything left. Never throws.
   */
  private readonly noteWriter = new NoteWriter(() => this.writePendingNotes());
  private writeNotes(): Promise<void> {
    return this.noteWriter.run();
  }

  /** One attempt, in batches that fit a checker call; true if nothing is left pending. */
  private async writePendingNotes(): Promise<boolean> {
    for (;;) {
      const pending = this.sql.exec<{ fork: string; landed_sha: string; note: string }>("SELECT fork, landed_sha, note FROM flight_logs WHERE noted = 0 ORDER BY landed_at").toArray();
      if (!pending.length) return true;
      const batch = takeBatch(pending);
      let error: string;
      try {
        const r = JSON.parse(
          await checkerFor(this.env, this.baseline, "land").run({ mode: "notes", baseline: await this.repoRef(this.baseline, "write"), notes: batch.map((p) => ({ sha: p.landed_sha, note: p.note })) }),
        ) as Partial<NotesResult> & { error?: string };
        // By the PRs sent, not by sha: a PR that added nothing shares its sha with the one before, and may not have been sent.
        const written = new Set(r.written ?? []);
        const done = batch.filter((p) => written.has(p.landed_sha));
        for (const p of done) this.sql.exec("UPDATE flight_logs SET noted = 1, note_error = NULL WHERE fork = ?", p.fork);
        if (!r.error && done.length) {
          this.log("notes.written", { forks: done.map((p) => p.fork) });
          continue; // next batch
        }
        error = r.error ?? "no notes written";
      } catch (err) {
        error = (err as Error).message;
      }
      this.sql.exec("UPDATE flight_logs SET note_error = ? WHERE noted = 0", error.slice(0, 300));
      this.log("notes.failed", { forks: batch.map((p) => p.fork), error: error.slice(0, 300) });
      return false;
    }
  }

  /** The PR's story so far, as the note ATC attaches to its landed commit. */
  private flightLogNote(f: ForkRow, onto: string, landed: boolean): string {
    const snapshots = this.sql
      .exec<{ at: number; sequence: string | null }>("SELECT at, json_extract(state, '$.sequence') AS sequence FROM snapshots ORDER BY id")
      .toArray()
      .map((r): SequenceSnapshot => ({ at: r.at, sequence: r.sequence ? (JSON.parse(r.sequence) as SequenceSnapshot["sequence"]) : [] }));
    snapshots.push({ at: Date.now(), sequence: this.sequence() }); // the latest clearance may not be recorded yet
    return flightLogNote({
      fork: f.name,
      agent: f.agent,
      diffLines: f.diff_lines,
      intents: this.sql.exec<{ description: string }>("SELECT description FROM intents WHERE fork = ? ORDER BY id", f.name).toArray().map((r) => r.description),
      signals: this.sql.exec<FlightSignal>("SELECT kind, about_fork, symbol, message, created_at FROM signals WHERE fork = ?", f.name).toArray(),
      clearances: clearanceHistory(snapshots, f.name),
      onto,
      landed,
    });
  }

  private flightLogs(): FlightLogEntry[] {
    return this.sql
      .exec<{ fork: string; landed_sha: string; landed_at: number; note: string; noted: number }>("SELECT fork, landed_sha, landed_at, note, noted FROM flight_logs ORDER BY landed_at")
      .toArray()
      .map((r) => ({ fork: r.fork, pr: prLabel(r.fork), landedSha: r.landed_sha, landedAt: r.landed_at, note: r.note, noted: r.noted === 1 }));
  }

  /**
   * Why main looks the way it does: the flight log of every landed PR, oldest first. With `fork`, also that PR's
   * log so far if it is still in flight.
   */
  async getHistory(fork?: string): Promise<{ baseline: string; baselineHead: string | null; landed: FlightLogEntry[]; inFlight?: { fork: string; pr: string; note: string } }> {
    const out: { baseline: string; baselineHead: string | null; landed: FlightLogEntry[]; inFlight?: { fork: string; pr: string; note: string } } = {
      baseline: this.baseline, baselineHead: this.meta("baseline_head"), landed: this.flightLogs(),
    };
    const row = fork ? this.fork(fork) : null;
    if (row?.status === "active") out.inFlight = { fork: row.name, pr: prLabel(row.name), note: this.flightLogNote(row, this.meta("baseline_head") ?? "", false) };
    return out;
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
    if (this.activeForks().length === 0 && !this.notesPending()) return;
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
    await this.requeuePairs();
    await this.restartStuckChecks();
    if (this.notesPending()) this.ctx.waitUntil(this.writeNotes());
    return found;
  }

  /** Mark activity so the reconcile alarm keeps running; called on every API call and push. */
  touch() {
    this.setMeta("last_activity", String(Date.now()));
  }

  override async alarm(): Promise<void> {
    if (await this.reconcile()) this.touch();
    const idle = Date.now() - Number(this.meta("last_activity") ?? 0);
    // Notes are retried after the last landing too; once idle, any API call (ensure → scheduleReconcile) re-arms it.
    if ((this.activeForks().length > 0 || this.notesPending()) && idle < RECONCILE_IDLE_MS) await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
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
      flightLogs: this.flightLogs(),
      savings: computeSavings(
        this.sql
          .exec<{ at: number; kind: string; fork: string | null; detail: string }>(
            `SELECT at, kind, fork, detail FROM event_log WHERE kind IN ('fork.created', 'fork.abandoned', 'push.received', 'land.requested', 'land.merged', 'signal.rebase_required', 'check.single', 'check.single.stale', 'check.pair') ORDER BY id`,
          )
          .toArray()
          .map((e): LogEvent => ({ ...e, detail: JSON.parse(e.detail) as unknown })),
      ),
      events: this.sql
        .exec<{ id: number; at: number; kind: string; fork: string | null; detail: string }>("SELECT * FROM event_log ORDER BY id DESC LIMIT 60")
        .toArray()
        .map((e) => ({ ...e, detail: JSON.parse(e.detail) as unknown })),
    };
  }
}

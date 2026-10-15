import { DurableObject } from "cloudflare:workers";
import { forkName, headOf, repoRef, type ForkIndex } from "./artifacts";
import { isPushed, type ArtifactsEvent } from "./events";
import { deletePushSubscription } from "./subscriptions";
import { checkerFor, type LandResult, type NotesResult, type PairResult, type SingleResult } from "./checker";
import {
  afterLanding, approachQueue, checkRetriesLeft, LANDING_LOCK_MS, type OpenConflict, forksToRecheck, reviewWaits, type ReviewRow, forksWaitingOnPairs, isDuplicateInstance, landGate, stuckCheck, type CheckRun, mayRelease, outstandingPairs, pairFailure, pairPartners, pairResultRow, pairsToQueue, parseLock, queuedPair,
  takeLock, type PairCheckRow, type PairQueueRow,
} from "./landing";
import { buildSequence, clearanceMessage, prLabel, type Conflict, type SequenceEntry } from "./atc";
import { attemptVerdicts, normalizeTask, standDowns, type Attempt, type AttemptVerdict, type TaskChoice } from "./attempts";
import { analyzePair, describeError } from "./conflicts";
import { NoteWriter, takeBatch } from "./notes";
import { clearanceHistory, flightLogNote, minimalFlightLog, type FlightSignal, type SequenceSnapshot } from "./flightlog";
import { flightLogs, overlaps, readModel, recordSnapshot, timelineJson } from "./readmodel";
import { COLUMNS, SCHEMA } from "./schema";
import { deliver } from "./webhooks";
import { intentConflicts, type DesiredSignal, type IndexSnapshot, type SignalKind } from "./signals";
import { emitSignal, indexSnapshot, relabel, resolveSignals, signalsFor, syncDerivedSignals } from "./signalstore";
import type { ChooseResult, ReviewResult, CoordinatorState, FlightLogEntry, ForkCredentials, ForkRow, LandResponse, Overlap, PushSource, SignalRow } from "./types";

const RECONCILE_MS = 5_000;
/** Storage bounds (prune): a 5-PR demo run writes about 600 events and 40 snapshots. */
export const KEEP_EVENTS = 20_000;
export const KEEP_SNAPSHOTS = 5_000;
/** Baselines whose recorded runs must never be pruned: the public replays, and the run the submitted video shows. */
export const keptBaselines = (env: Pick<Env, "PUBLIC_REPLAY_BASELINES">) =>
  new Set([...(env.PUBLIC_REPLAY_BASELINES ?? "").split(","), "booking-261010213346"].map((s) => s.trim()).filter(Boolean));
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
    for (const c of COLUMNS)
      if (!this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${c.table}')`).toArray().some((r) => r.name === c.column)) this.sql.exec(c.ddl);
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
    if (head) this.setMainHead(head.hash);
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
    try {
      this.syncAttemptSignals();
    } catch (err) {
      console.error("stand-down signals failed", err); // never at the cost of the snapshot and the live push
    }
    const model = this.readModel();
    const full = JSON.stringify(model);
    recordSnapshot(this.sql, model); // for replay, only when the airspace actually changed
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
    return timelineJson(this.sql, this.meta("baseline"));
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
    for (const h of hooks) this.ctx.waitUntil(deliver(h.url, h.secret, body));
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


    const now = Date.now();
    this.sql.exec(
      `INSERT INTO forks(name, agent, pr, status, created_at, base_sha, head_sha, processed_sha, subscription_id, remote)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET agent = excluded.agent, status = 'active', created_at = excluded.created_at,
         base_sha = excluded.base_sha, head_sha = excluded.head_sha, processed_sha = excluded.processed_sha,
         subscription_id = excluded.subscription_id, remote = excluded.remote, diff_lines = 0,
         land_requested_at = NULL, check_status = 'unknown', check_sha = NULL, check_detail = NULL, check_main_conflict = 0`,
      name, agent, pr, now, baseHead.hash, baseHead.hash, baseHead.hash, null, forked.remote, // subscription: attachSubscription (ADR-0009)
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
      // An event (possibly a delayed queue retry, or out of order) only says main moved: read where it is now.
      if (source === "event") await this.syncMainHead("event");
      else await this.baselineMoved(sha, source);
      return;
    }
    if (source === "event" && this.fork(repo)?.status === "active") {
      // Same for a fork: a retried or reordered event can carry an older head than one already applied (review of #33).
      const live = await headOf(this.env, repo).catch(() => null);
      if (!live) {
        // Can't tell whether the event is current. Throw, so the queue redelivers it with a back-off (and after
        // max_retries keeps it in the DLQ); meanwhile reconcile reads the fork's head too (review of #35).
        this.log("push.event_unverified", { sha }, repo);
        throw new Error(`couldn't read ${repo}'s head to verify push ${sha.slice(0, 7)}; retry`);
      }
      if (live.hash !== sha) {
        this.log("push.event_stale", { sha, live: live.hash }, repo);
        sha = live.hash;
      }
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
    this.resolveSignals({ fork: repo, kind: "review" }); // an earlier verdict was for older code
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
    this.setMainHead(sha);
    this.log("baseline.pushed", { sha, source });
    await this.recheckAll(new Set());
  }

  /**
   * Read main's head from Artifacts and take it, unless main moved (a landing, or another read) while the read was in
   * flight: then the answer may be older than what ATC already has, and taking it would move main backwards, re-check
   * every PR on the old main, and leave them pending (third review of #30). A dropped read is retried by the next
   * reconcile, 5 s later, so a wrong answer can't stick.
   */
  private async syncMainHead(source: PushSource): Promise<void> {
    const baseline = this.meta("baseline");
    if (!baseline) return;
    // A landing in progress may already have pushed main; onLanded records that head itself. Reading now would take
    // ATC's own landing for an outside push and re-check everyone, go-arounds included (review of #31).
    if (this.landingInProgress()) {
      // onLanded records the head; the next read after it confirms. Logged once per landing, not every 5 s (review of #40).
      const lock = this.meta("landing") ?? "";
      if (this.meta("read_deferred_for") !== lock) {
        this.setMeta("read_deferred_for", lock);
        this.log("baseline.read_deferred", { source });
      }
      return;
    }
    const epoch = this.meta("main_epoch");
    const live = await headOf(this.env, baseline).catch(() => null);
    if (!live) return;
    if (this.meta("main_epoch") !== epoch || this.landingInProgress()) {
      this.log("baseline.stale_read", { read: live.hash, head: this.meta("baseline_head"), source });
      return;
    }
    await this.baselineMoved(live.hash, source);
  }

  private landingInProgress(): boolean {
    const l = parseLock(this.meta("landing"));
    return !!l && l.at > Date.now() - LANDING_LOCK_MS;
  }

  /** The only writer of baseline_head. Bumps main_epoch, so a head read that was in flight meanwhile is discarded. */
  private setMainHead(sha: string) {
    this.setMeta("baseline_head", sha);
    this.setMeta("main_epoch", String(Number(this.meta("main_epoch") ?? 0) + 1));
  }

  /**
   * kind "push": full pipeline (index, overlap signals, PR-on-main check, pair merges).
   * kind "recheck": main moved; only re-verify that the PR still merges onto the new main and typechecks.
   * kind "pairs": a pair check was lost or went stale; re-run just those pairs at the current heads.
   * Returns false if the instance couldn't be created (usually: the same push was already started).
   */
  /** `restart`: the n-th time ATC starts this PR's checks again by itself (a new instance id, see restartStuckChecks). */
  private async startPipeline(fork: string, sha: string, kind: "push" | "recheck" | "pairs" = "push", others: Array<{ name: string; sha: string }> = [], restart = 0): Promise<boolean> {
    const main = this.meta("baseline_head") ?? "";
    const raw =
      kind === "pairs"
        ? `p${Date.now()}-${sha.slice(0, 12)}-${others.map((o) => o.sha.slice(0, 12)).join("-")}-${fork}` // unique part first: ids are cut at 100 chars
        : `${fork}-${sha.slice(0, 12)}${kind === "recheck" ? `-m${main.slice(0, 10)}` : ""}${restart ? `-r${restart}` : ""}`;
    const id = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
    try {
      await this.env.PUSH_PIPELINE.create({ id, params: { baseline: this.baseline, fork, sha, kind, others, ...(kind === "pairs" ? {} : { main }) } });
      this.log("pipeline.started", { sha, instance: id }, fork);
      if (kind !== "pairs") this.recordCheckRun(fork, sha, restart);
      return true;
    } catch (err) {
      const error = (err as Error).message;
      // Same push seen twice (event + reconcile, or queue redelivery) → instance already exists. Anything else is real.
      // A duplicate leaves check_runs alone: the run that exists keeps its start time, so polling request_land (which
      // re-requests a re-check every few seconds) can't keep a hung run from ever counting as stuck.
      if (isDuplicateInstance(error)) this.log("pipeline.duplicate", { sha, instance: id }, fork);
      else {
        this.log("pipeline.start_failed", { sha, instance: id, kind, error: error.slice(0, 300) }, fork);
        if (kind !== "pairs") this.recordCheckRun(fork, sha, restart); // so the reconcile alarm tries again later
      }
      return false;
    }
  }

  /** The latest push/re-check run started for a fork, for restartStuckChecks. Restarts count per head. */
  private recordCheckRun(fork: string, sha: string, restart: number) {
    this.sql.exec(
      `INSERT INTO check_runs(fork, sha, started_at, restarts) VALUES (?, ?, ?, ?)
       ON CONFLICT(fork) DO UPDATE SET started_at = excluded.started_at,
         restarts = CASE WHEN check_runs.sha = excluded.sha THEN max(check_runs.restarts, excluded.restarts) ELSE excluded.restarts END, sha = excluded.sha`,
      fork, sha, Date.now(), restart,
    );
  }

  /**
   * The Workflow for this push (or re-check) failed for good. Show it as an error, not as pending forever (issue #2).
   * `main`: for a re-check, the main it was checking on; a failure on a main that has since moved is ignored (the
   * re-check on the new main is already running).
   */
  async applyPipelineFailure(fork: string, sha: string, error: string, main?: string): Promise<void> {
    const row = this.fork(fork);
    // A run on a main that has since moved is superseded by the re-check on the new main, unless its push was never
    // indexed (that part isn't redone by a re-check).
    const current = row?.status === "active" && row.head_sha === sha && (!main || main === this.meta("baseline_head") || row.processed_sha !== sha);
    this.log("pipeline.failed", { sha, main, error: error.slice(0, 300), current }, fork);
    if (!current) return; // a newer push, or a re-check on a newer main, has its own pipeline
    if (this.markCheckError(fork, sha, error)) {
      this.touch();
      await this.scheduleReconcile();
    }
  }

  /** Record that this PR's checks couldn't run, unless a (duplicate) run already has a result. True if recorded. */
  private markCheckError(fork: string, sha: string, error: string): boolean {
    const row = this.fork(fork)!;
    // A result stands, unless the push itself was never indexed: a re-check alone can't finish that PR's checks.
    if (row.processed_sha === sha && row.check_sha === sha && (row.check_status === "green" || row.check_status === "red")) return false;
    this.sql.exec("UPDATE forks SET check_status = 'error', check_sha = ?, check_detail = ?, check_main_conflict = 0 WHERE name = ?", sha, error.slice(0, 500), fork);
    this.emitSignal({
      fork, kind: "check_failed", about_fork: null, symbol: null,
      message: `ATC couldn't run the checks on your push ${sha.slice(0, 7)} (${error.slice(0, 120)}). It retries by itself; you can also push again.`,
      data: { error: error.slice(0, 500) }, dedupe_key: `check_failed:${fork}:${sha}`,
    });
    return true;
  }

  /** From the reconcile alarm: start checks again that errored or have been pending too long; give up after a few tries. */
  private async restartStuckChecks() {
    const runs = new Map(this.sql.exec<CheckRun>("SELECT * FROM check_runs").toArray().map((r) => [r.fork, r]));
    const head = this.meta("baseline_head") ?? "";
    const now = Date.now();
    // Decide and write everything before the first await (as requeuePairs does): a result or a push that arrives
    // while a Workflow is being created must not be overwritten by a decision made on the old state.
    const restarts: Array<{ name: string; sha: string; kind: "push" | "recheck"; attempt: number }> = [];
    const goAround = this.goAroundMap(); // sent around on purpose and not re-checked (onLanded): a new push decides
    const finals = this.finalLosers(); // can't land: nothing to check until they push or leave the task
    for (const f of this.activeForks()) {
      if (goAround.has(f.name) || finals.has(f.name)) continue;
      const s = stuckCheck(f, runs.get(f.name), head, now);
      if (!s) continue;
      if ("giveUp" in s) {
        this.log("check.gave_up", { sha: f.head_sha }, f.name);
        this.markCheckError(f.name, f.head_sha, "checks didn't finish after several tries");
        continue;
      }
      this.log("check.restarted", { sha: f.head_sha, kind: s.restart, attempt: s.attempt }, f.name);
      // Pending again (not "error"), so this run gets the full CHECK_STUCK_MS before it counts as stuck.
      this.sql.exec("UPDATE forks SET check_status = 'pending' WHERE name = ?", f.name);
      this.sql.exec("UPDATE check_runs SET sha = ?, started_at = ?, restarts = max(restarts, ?) WHERE fork = ?", f.head_sha, now, s.attempt, f.name);
      restarts.push({ name: f.name, sha: f.head_sha, kind: s.restart, attempt: s.attempt });
    }
    if (restarts.length) this.touch(); // keep the alarm running until these runs report back
    for (const r of restarts) {
      const f = this.fork(r.name);
      if (f?.status === "active" && f.head_sha === r.sha && f.check_status === "pending") await this.startPipeline(r.name, r.sha, r.kind, [], r.attempt);
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
    return indexSnapshot(this.sql, this.activeForks());
  }

  /** Agents and the dashboard talk in PR numbers: replace fork repo names with "PR<N>". */
  private relabel(text: string): string {
    return relabel(this.sql, text);
  }

  emitSignal(input: DesiredSignal): boolean {
    return emitSignal(this.sql, (k, d, f) => this.log(k, d, f), input);
  }

  resolveSignals(where: { fork?: string; kind?: SignalKind; about_fork?: string }) {
    resolveSignals(this.sql, where);
  }

  /** Recompute index-derived signals; emit new ones and resolve ones that no longer hold. */
  private syncDerivedSignals() {
    syncDerivedSignals(this.sql, (k, d, f) => this.log(k, d, f), this.snapshot());
  }

  /** Record what an agent plans to touch; return in-flight work it collides with. */
  /**
   * `task`: the task this PR is an attempt at (issue #19); PRs whose latest intents name the same task compete.
   * Left out (undefined), the PR keeps the task it had: re-declaring a plan mustn't silently leave the task (review of
   * #45). An empty string or null clears it.
   */
  async declareIntent(fork: string, description: string, files: string[], symbols: string[], task?: string | null) {
    const row = this.fork(fork);
    if (!row || row.status !== "active") throw new Error(`unknown or inactive fork ${fork}`);
    const conflicts = intentConflicts(this.snapshot(), fork, files, symbols);
    const previous = this.anyTasks() ? (this.tasks().get(fork) ?? null) : null;
    const key = task === undefined ? previous : normalizeTask(task);
    // Leaving a task ends a person's pick of this PR for it: coming back later mustn't revive it (review of #45).
    if (previous && previous !== key) this.sql.exec("DELETE FROM task_choices WHERE task = ? AND winner = ?", previous, fork);
    const before = this.attemptVerdicts().get(fork);
    this.sql.exec(
      "INSERT INTO intents(fork, description, files, symbols, created_at, task) VALUES (?, ?, ?, ?, ?, ?)",
      fork, description, JSON.stringify(files), JSON.stringify(symbols), Date.now(), key,
    );
    this.log("intent.declared", { description, files, symbols, conflicts: conflicts.length, task: key }, fork);
    if (key) this.setMeta("tasks_seen", "1");
    this.syncDerivedSignals();
    // Left a task that had already landed: the landing skipped re-checking this PR (it couldn't land then). It can now,
    // so check it on current main, which also tells it if it conflicts with what landed (review of #45).
    if (before?.kind === "stand_down" && before.final && this.attemptVerdicts().get(fork)?.kind !== "stand_down" && row.head_sha !== row.base_sha) {
      this.sql.exec("UPDATE forks SET check_status = 'pending' WHERE name = ?", fork);
      await this.startPipeline(fork, row.head_sha, "recheck");
    }
    // Who else is on this task: the agent learns it competes before it writes any code.
    const rivals = key ? this.attempts().filter((a) => a.task === key && a.fork.name !== fork).map((a) => a.fork.name) : [];
    // PRs that already landed this task: a late duplicate learns it before writing code (review of #45).
    const tasks = key ? this.tasks() : new Map<string, string | null>();
    const landedBy = key
      ? this.sql.exec<{ name: string }>("SELECT name FROM forks WHERE status = 'landed' ORDER BY landed_at").toArray().map((r) => r.name).filter((n) => tasks.get(n) === key)
      : [];
    return { fork, recorded: true, overlaps: conflicts, ...(key ? { task: key, sameTask: rivals, landedBy } : {}) };
  }

  /** Signals addressed to `fork`. Open ones by default; `includeResolved` for history. */
  async getSignals(fork: string, includeResolved = false): Promise<SignalRow[]> {
    return signalsFor(this.sql, fork, includeResolved);
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

  private setCheck(fork: string, sha: string, ok: boolean, detail: string, base: string | null, onMain = false) {
    const row = this.fork(fork);
    if (!row || row.head_sha !== sha) return; // stale result; a newer push is being checked
    this.sql.exec(
      "UPDATE forks SET check_status = ?, check_sha = ?, check_base = ?, check_detail = ?, check_main_conflict = ? WHERE name = ?",
      ok ? "green" : "red", sha, base, detail, !ok && onMain ? 1 : 0, fork,
    );
    // The checks ran after all: an earlier "ATC couldn't run the checks" no longer applies (pair ones are per pair).
    this.sql.exec("UPDATE signals SET resolved_at = ? WHERE fork = ? AND kind = 'check_failed' AND about_fork IS NULL AND resolved_at IS NULL", Date.now(), fork);
  }

  /** Result of "this PR merged onto current main typechecks?" — the PR's green/red status. */
  async applySingle(json: string): Promise<void> {
    const r = JSON.parse(json) as SingleResult;
    const errs = r.result.errors.map(describeError).join("\n") || r.result.output.slice(0, 500);
    const detail = r.result.ok ? "merges onto main and typechecks" : errs;
    if (r.baseHead && r.baseHead !== this.meta("baseline_head")) {
      this.log("check.single.stale", { checkedOn: r.baseHead, timings: r.timings ?? [] }, r.repo); // main moved during the check; a recheck follows
      return;
    }
    this.setCheck(r.repo, r.forkSha, r.result.ok, detail, r.baseHead, !!r.mainConflict);
    this.log("check.single", { sha: r.forkSha, ok: r.result.ok, onMain: r.baseHead, mainConflict: !!r.mainConflict, errors: r.result.errors.length, timings: r.timings ?? [] }, r.repo);
  }

  /** Main moved: re-verify every waiting PR against the new main (no rebase needed unless it no longer fits). */
  private async recheckAll(except: Set<string>) {
    // Final losers can't land (issue #19): re-checking them on every main move is wasted work (review of #45).
    const due = forksToRecheck(this.activeForks(), this.meta("baseline_head") ?? "", new Set([...except, ...this.finalLosers()]));
    // Mark them all before the first await; then start each only if nothing changed meanwhile (a result or a push).
    for (const f of due) this.sql.exec("UPDATE forks SET check_status = 'pending' WHERE name = ?", f.name);
    for (const { name, head_sha } of due) {
      const now = this.fork(name);
      if (now?.status === "active" && now.head_sha === head_sha && now.check_status === "pending") await this.startPipeline(name, head_sha, "recheck");
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
    const runs = new Map(this.sql.exec<CheckRun>("SELECT * FROM check_runs").toArray().map((r) => [r.fork, r]));
    const forks = this.activeForks();
    const gaveUp = new Set(forks.filter((f) => !checkRetriesLeft(f, runs.get(f.name))).map((f) => f.name));
    const pairsPending = forksWaitingOnPairs(this.outstandingPairs());
    const conflicts = this.conflictMap();
    const goAround = this.goAroundMap();
    return buildSequence(forks, conflicts, this.meta("baseline_head") ?? "", goAround, pairsPending, gaveUp, this.reviewWaits(), this.attemptVerdicts({ pairsPending, conflicts, goAround, gaveUp }));
  }

  // ── competing attempts at one task (issue #19, ADR-0026) ───────────────

  /** fork → the task its latest intent names (null: none). */
  private tasks(): Map<string, string | null> {
    return new Map(
      this.sql.exec<{ fork: string; task: string | null }>("SELECT fork, task FROM intents WHERE id IN (SELECT max(id) FROM intents GROUP BY fork)").toArray().map((r) => [r.fork, r.task]),
    );
  }

  /** Any intent names a task? If not (the usual case), nothing about attempts needs computing. */
  private anyTasks(): boolean {
    // A flag set by declareIntent, so the usual case (no task ever) costs one meta read. Missing on a DO that recorded
    // tasks before the flag existed: look once, and remember.
    const seen = this.meta("tasks_seen");
    if (seen !== null) return seen === "1";
    const any = this.sql.exec("SELECT 1 FROM intents WHERE task IS NOT NULL LIMIT 1").toArray().length > 0;
    this.setMeta("tasks_seen", any ? "1" : "0");
    return any;
  }

  /** Active PRs that name a task, with what compareAttempts needs. */
  private attempts(conflicts = this.conflictMap(), tasks = this.tasks()): Attempt[] {
    const forks = this.activeForks().filter((f) => tasks.get(f.name));
    const count = (q: string, fork: string) => this.sql.exec<{ n: number }>(q, fork).one().n;
    return forks.map((f) => {
      const task = tasks.get(f.name)!;
      const others = new Set((conflicts.get(f.name) ?? []).map((c) => c.other).filter((o) => tasks.get(o) !== task && this.fork(o)?.status === "active"));
      // When it started naming this task: the oldest intent in its latest unbroken run of intents naming it.
      const run = this.sql.exec<{ task: string | null; created_at: number }>("SELECT task, created_at FROM intents WHERE fork = ? ORDER BY id DESC", f.name).toArray();
      let since = f.created_at;
      for (const i of run) {
        if (i.task !== task) break;
        since = i.created_at;
      }
      return {
        fork: f, task, conflicts: others.size, since,
        breaking: count("SELECT count(*) AS n FROM symbol_changes WHERE fork = ? AND change IN ('signature_changed', 'removed')", f.name),
        symbols: count("SELECT count(*) AS n FROM symbol_changes WHERE fork = ?", f.name),
        files: count("SELECT count(*) AS n FROM touched WHERE fork = ?", f.name),
      };
    });
  }

  /** Pass what the caller already computed; anything left out is read here (only when some intent names a task). */
  private attemptVerdicts(
    known: { pairsPending?: Set<string>; conflicts?: Map<string, Conflict[]>; goAround?: Map<string, string>; gaveUp?: Set<string> } = {},
  ): Map<string, AttemptVerdict> {
    if (!this.anyTasks()) return new Map();
    const tasks = this.tasks();
    const attempts = this.attempts(known.conflicts ?? this.conflictMap(), tasks);
    if (!attempts.length) return new Map();
    const landed = this.sql
      .exec<{ name: string; landed_at: number }>("SELECT name, landed_at FROM forks WHERE status = 'landed' ORDER BY landed_at")
      .toArray()
      .flatMap((r) => (tasks.get(r.name) ? [{ fork: r.name, task: tasks.get(r.name)!, landedAt: r.landed_at }] : []));
    const runs = new Map(this.sql.exec<CheckRun>("SELECT * FROM check_runs").toArray().map((r) => [r.fork, r]));
    const sentAround = new Map(
      this.sql.exec<{ fork: string; at: number }>("SELECT fork, max(created_at) AS at FROM signals WHERE kind = 'rebase_required' AND resolved_at IS NULL GROUP BY fork").toArray().map((r) => [r.fork, r.at]),
    );
    return attemptVerdicts(attempts, landed, {
      leaders: new Map(this.sql.exec<{ task: string; fork: string }>("SELECT task, fork FROM task_leaders").toArray().map((r) => [r.task, r.fork])),
      sentAround,
      now: Date.now(),
      baselineHead: this.meta("baseline_head") ?? "",
      pairsPending: known.pairsPending ?? forksWaitingOnPairs(this.outstandingPairs()),
      choices: this.sql.exec<TaskChoice>("SELECT * FROM task_choices").toArray(),
      goAround: new Set((known.goAround ?? this.goAroundMap()).keys()),
      gaveUp: known.gaveUp ?? new Set(attempts.filter((a) => !checkRetriesLeft(a.fork, runs.get(a.fork.name))).map((a) => a.fork.name)),
    });
  }

  /** PRs that stand down for good (another attempt at their task landed): they can't land, so ATC doesn't check them. */
  private finalLosers(): Set<string> {
    return new Set([...standDowns(this.attemptVerdicts())].filter(([, v]) => v.final).map(([f]) => f));
  }

  /** Tell each attempt that stands down, once per (head, winner, basis); resolve the notes that no longer hold. */
  private syncAttemptSignals() {
    if (!this.anyTasks()) return; // stand_down signals exist only once some intent named a task
    const verdicts = this.attemptVerdicts();
    const down = standDowns(verdicts);
    // Remember ATC's pick per task, so a go-around from another landing doesn't hand the task over (attemptVerdicts).
    const tasks = this.tasks();
    for (const [fork, v] of verdicts) {
      const task = v.kind === "chosen" ? tasks.get(fork) : null;
      if (task)
        this.sql.exec("INSERT INTO task_leaders(task, fork, at) VALUES (?, ?, ?) ON CONFLICT(task) DO UPDATE SET fork = excluded.fork, at = excluded.at WHERE task_leaders.fork <> excluded.fork", task, fork, Date.now());
    }
    const open = this.sql.exec<{ id: number; fork: string; dedupe_key: string }>("SELECT id, fork, dedupe_key FROM signals WHERE kind = 'stand_down' AND resolved_at IS NULL").toArray();
    const keys = new Map<string, string>();
    for (const [fork, v] of down) keys.set(fork, `stand_down:${fork}:${this.fork(fork)?.head_sha ?? ""}:${v.winner}:${v.basis}`);
    // A note stays open while its task is still contested and nothing replaced it: when the winner pushes again, the
    // loser is briefly undecided (waiting, or its pair checks are out), and re-opening the note each time is just noise.
    const contested = new Set(this.attempts().filter((x) => x.fork.head_sha !== x.fork.base_sha).map((x) => x.task).filter((t, i, all) => all.indexOf(t) !== i));
    const stillOpen = (fork: string) => {
      const v = verdicts.get(fork);
      if (v?.kind === "stand_down" || v?.kind === "chosen") return false; // replaced, or it ships now
      const task = tasks.get(fork);
      return this.fork(fork)?.status === "active" && !!task && contested.has(task);
    };
    for (const s of open) if (keys.get(s.fork) !== s.dedupe_key && !stillOpen(s.fork)) this.sql.exec("UPDATE signals SET resolved_at = ? WHERE id = ?", Date.now(), s.id);
    for (const [fork, v] of down)
      this.emitSignal({ fork, kind: "stand_down", about_fork: v.winner, symbol: null, message: this.relabel(v.reason), data: { winner: v.winner, final: v.final }, dedupe_key: keys.get(fork)! });
  }

  /**
   * A person picks which attempt at a task ships (dashboard PICK, or POST /choose). It overrides ATC's ranking until
   * someone picks again; the winner still has to pass every other check.
   */
  async choose(fork: string, by: string): Promise<ChooseResult> {
    const refuse = (status: number, error: string): ChooseResult => ({ ok: false, status, error: this.relabel(error) });
    const row = this.fork(fork);
    if (!row || row.status !== "active") return refuse(404, `unknown or inactive fork ${fork}`);
    const task = this.tasks().get(fork);
    if (!task) return refuse(409, `${prLabel(fork)} hasn't named a task (declare_intent with a task)`);
    const verdicts = this.attemptVerdicts();
    const verdict = verdicts.get(fork);
    if (verdict?.kind === "stand_down" && verdict.final) return refuse(409, this.relabel(verdict.reason));
    // Only attempts with pushed changes count, as in attemptVerdicts: a pick against one with nothing pushed would do nothing.
    // Final losers from an earlier landing don't compete either (review of #45).
    const live = (a: Attempt) => a.task === task && a.fork.head_sha !== a.fork.base_sha && !(verdicts.get(a.fork.name)?.kind === "stand_down" && (verdicts.get(a.fork.name) as { final: boolean }).final);
    if (this.attempts().filter(live).length < 2 || row.head_sha === row.base_sha)
      return refuse(409, `${prLabel(fork)} has no other attempt at ${task} with pushed changes: nothing to choose`);
    // A landing in flight passed the gate with the old pick; changing it now would mislead the log (as for review).
    if (this.landingInProgress()) return refuse(409, "a landing is in progress; pick again in a few seconds");
    const who = by.trim().slice(0, 60) || "a person";
    this.sql.exec(
      "INSERT INTO task_choices(task, winner, by, at) VALUES (?, ?, ?, ?) ON CONFLICT(task) DO UPDATE SET winner = excluded.winner, by = excluded.by, at = excluded.at",
      task, fork, who, Date.now(),
    );
    this.log("attempt.chosen", { task, by: who }, fork);
    this.touch();
    this.syncAttemptSignals();
    return { ok: true, task, winner: fork, by: who, clearance: this.sequence().find((e) => e.fork === fork)?.clearance };
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

  // ── review gate (issue #16, ADR-0023) ───────────────────────────────────

  private reviewRequired() {
    return this.meta("review_required") === "1";
  }

  /** Turn the review gate on or off for this baseline (off by default, so the demo is unchanged). */
  async setReviewRequired(on: boolean): Promise<{ reviewRequired: boolean; error?: string }> {
    // A landing in flight passed the gate as it was; switching now would let it land "unreviewed" under the new rule.
    if (this.landingInProgress()) return { reviewRequired: this.reviewRequired(), error: "a landing is in progress; try again in a few seconds" };
    this.setMeta("review_required", on ? "1" : "0");
    this.log("review.gate", { on });
    return { reviewRequired: on };
  }

  private reviewWaits(): Map<string, string> {
    return reviewWaits(this.activeForks(), this.sql.exec<ReviewRow>("SELECT * FROM reviews").toArray(), this.reviewRequired());
  }

  /**
   * A reviewer (an agent through MCP, or a person on the dashboard) approves or requests changes on a PR's CURRENT
   * head. A later push needs a new review. The author is told through a signal; the note goes into the flight log.
   */
  async review(fork: string, verdict: "approve" | "request_changes", note: string, reviewer: string, sha: string): Promise<ReviewResult> {
    // Refusals are returned, not thrown: an error's class doesn't survive the Durable Object RPC boundary.
    const refuse = (status: number, error: string): ReviewResult => ({ ok: false, status, error: this.relabel(error) });
    const row = this.fork(fork);
    if (!row || row.status !== "active") return refuse(404, `unknown or inactive fork ${fork}`);
    if (row.head_sha === row.base_sha) return refuse(409, `${prLabel(fork)} has no pushed changes to review`);
    // The verdict is for the code the reviewer read: if the PR moved since, it must be reviewed again (review of #38).
    if (!sha || !row.head_sha.startsWith(sha) || (sha.length < 7 && sha !== row.head_sha))
      return refuse(409, `${prLabel(fork)} is at ${row.head_sha.slice(0, 7)}, not ${sha.slice(0, 7) || "(no sha)"}: review its current head`);
    // A landing in flight already checked the approval; a verdict now would change nothing and mislead the log.
    // Only the PR being landed: its landing already checked the approval (others needn't wait; review of #38).
    const landing = parseLock(this.meta("landing"));
    if (this.landingInProgress() && (!landing?.fork || landing.fork === fork))
      return refuse(409, landing?.fork ? `${prLabel(fork)} is landing right now; send the review again in a few seconds` : "a landing is in progress; send the review again in a few seconds");
    const who = reviewer.trim().slice(0, 60) || "reviewer";
    const text = note.trim().slice(0, 500);
    this.sql.exec(
      `INSERT INTO reviews(fork, sha, verdict, reviewer, note, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(fork) DO UPDATE SET sha = excluded.sha, verdict = excluded.verdict, reviewer = excluded.reviewer, note = excluded.note, at = excluded.at`,
      fork, row.head_sha, verdict, who, text, Date.now(),
    );
    this.log(verdict === "approve" ? "review.approved" : "review.changes_requested", { sha: row.head_sha, reviewer: who, note: text }, fork);
    this.resolveSignals({ fork, kind: "review" });
    this.emitSignal({
      fork, kind: "review", about_fork: null, symbol: null,
      message: verdict === "approve"
        ? `${who} approved ${prLabel(fork)} at ${row.head_sha.slice(0, 7)}${text ? `: ${text}` : "."}`
        : `${who} requested changes on ${prLabel(fork)} at ${row.head_sha.slice(0, 7)}${text ? `: ${text}` : "."}${this.reviewRequired() ? " Push a fix; it needs a new review." : ""}`,
      data: { verdict, reviewer: who, note: text, sha: row.head_sha }, dedupe_key: `review:${fork}:${row.head_sha}:${verdict}:${Date.now()}`,
    });
    this.touch();
    return { ok: true, fork, sha: row.head_sha, verdict, clearance: this.sequence().find((e) => e.fork === fork)?.clearance };
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
   * closer to landing (ADR-0011), it yields. On landing, conflicting forks are sent around (rebase onto the new main, then land).
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
    await this.syncMainHead("land");
    const baselineHead = this.meta("baseline_head") ?? "";
    const me = this.fork(fork)!;

    const deny = (raw: string, kind: SignalKind | null = "land_blocked"): LandResponse => {
      const reason = this.relabel(raw);
      this.log("land.denied", { reason }, fork);
      if (kind)
        this.emitSignal({ fork, kind, about_fork: null, symbol: null, message: reason, data: { baselineHead }, dedupe_key: `${kind}:${fork}:${me.head_sha}:${baselineHead}:${reason.slice(0, 40)}` });
      const entry = this.sequence().find((e) => e.fork === fork); // built once (it's the costliest read here)
      return { landed: false, fork, reason, baselineHead, atc: entry ? clearanceMessage(entry) : undefined };
    };

    const waits = this.reviewWaits();
    const pairsPending = forksWaitingOnPairs(this.outstandingPairs());
    const attempts = this.attemptVerdicts({ pairsPending });
    const gate = landGate({
      me, baselineHead, goAround: this.goAroundMap().get(fork), waitingOnPairs: pairsPending.has(fork), attempt: attempts.get(fork),
      // A rival waiting for review, or standing down (issue #19), can't land, so it isn't ahead.
      rivals: this.rivals(fork).filter((r) => !waits.has(r.name) && attempts.get(r.name)?.kind !== "stand_down"),
      checkRetriesLeft: checkRetriesLeft(me, this.sql.exec<CheckRun>("SELECT * FROM check_runs WHERE fork = ?", fork).toArray()[0]),
      awaitingReview: waits.get(fork),
    });
    if (gate.kind === "deny") {
      // A stand-down's signal is kept by syncAttemptSignals (one per head and winner), not one per denied request.
      if (gate.signal === "stand_down") this.syncAttemptSignals();
      return deny(gate.reason, gate.signal === "stand_down" ? null : gate.signal);
    }
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
    this.setMeta("landing", JSON.stringify({ ...lock, fork }));
    try {
      // The story up to the moment it lands. A bug in building it must never fail a landing: fall back to the basics.
      let note: string;
      try {
        note = this.flightLogNote(me, baselineHead, true);
      } catch (err) {
        this.log("notes.build_failed", { error: (err as Error).message.slice(0, 300) }, fork);
        note = minimalFlightLog(me.name, me.agent, baselineHead);
      }
      // Tokens and the land run itself can fail outright (a container restarting after a deploy, a network error).
      // That is a retry, not a 500: nothing landed that ATC knows of, and if the push did go through, the next request
      // reads the new main and re-checks the PR (ADR-0018).
      let result: LandResult & { error?: string };
      try {
        const [forkRef, baseRef] = await Promise.all([this.repoRef(fork, "read"), this.repoRef(baseline, "write")]);
        // Pin both heads (issue #1): land exactly the fork commit ATC checked, onto exactly the main it was checked on.
        result = JSON.parse(
          await checkerFor(this.env, baseline, "land").run({
            mode: "land", fork: { ...forkRef, expectedHead: me.head_sha }, baseline: { ...baseRef, expectedHead: baselineHead },
          }),
        ) as LandResult & { error?: string };
      } catch (err) {
        const error = (err as Error).message.slice(0, 300);
        this.log("land.failed", { error }, fork);
        return { landed: false, fork, reason: `ATC couldn't run the landing (${error.slice(0, 120)}); retry in a few seconds.`, baselineHead, retry: true };
      }
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

  private repoRef(repo: string, scope: "read" | "write") {
    return repoRef(this.env, repo, scope, 600);
  }

  /**
   * After a landing: announce it to everyone. Only PRs with an open conflict against the winner must go around;
   * the rest stay in line and are automatically re-checked on the new main (ATC merges them when they land).
   */
  private async onLanded(winner: ForkRow, newHead: string, previousHead: string, merged: boolean, note: string): Promise<LandResponse> {
    const now = Date.now();
    this.setMainHead(newHead);
    this.sql.exec("UPDATE forks SET status = 'landed', landed_at = ? WHERE name = ?", now, winner.name);
    this.sql.exec(
      "INSERT OR REPLACE INTO flight_logs(fork, landed_sha, landed_at, note, noted, note_error) VALUES (?, ?, ?, ?, 0, NULL)",
      winner.name, newHead, now, note,
    );
    this.log("land.merged", { head: newHead, previousHead, diffLines: winner.diff_lines, mergedByATC: merged }, winner.name);
    if (winner.subscription_id) await deletePushSubscription(this.env, winner.subscription_id).catch(() => undefined);

    this.resolveSignals({ fork: winner.name });
    // Other attempts at the winner's task now stand down for good (issue #19): telling them to go around (rebase, fix,
    // push) or re-checking them would be wasted work, since they can't land (review of #45). They get a stand_down.
    const finals = this.finalLosers(); // every final loser, whoever won its task: none of them is told to stay in line
    for (const f of finals) this.resolveSignals({ fork: f, about_fork: winner.name });
    const split = afterLanding(
      winner.name,
      this.activeForks().filter((f) => !finals.has(f.name)),
      this.sql
        .exec<OpenConflict>("SELECT fork, about_fork, symbol, message FROM signals WHERE about_fork = ? AND kind IN ('semantic_conflict', 'merge_conflict') AND resolved_at IS NULL ORDER BY id", winner.name)
        .toArray(),
    );
    for (const g of split.goAround) {
      this.resolveSignals({ fork: g.fork, about_fork: winner.name });
      this.emitSignal({
        fork: g.fork, kind: "rebase_required", about_fork: winner.name, symbol: g.symbol,
        message: `${winner.name} landed (main is now ${newHead.slice(0, 7)}) and your PR conflicts with it${g.symbol ? ` on ${g.symbol}` : ""}. Go around: rebase onto main, fix, push. Finding: ${g.finding}`,
        data: { newHead }, dedupe_key: `rebase:${g.fork}:${newHead}`,
      });
    }
    for (const name of split.stayInLine) {
      this.resolveSignals({ fork: name, about_fork: winner.name });
      this.emitSignal({
        fork: name, kind: "landed", about_fork: winner.name, symbol: null,
        message: `${winner.name} landed (main is now ${newHead.slice(0, 7)}). No conflict with your PR: stay in line, no rebase needed. ATC is re-checking your PR on the new main.`,
        data: { newHead }, dedupe_key: `landed-ahead:${name}:${newHead}`,
      });
    }
    const goAround = split.goAround.map((g) => g.fork);
    this.emitSignal({
      fork: winner.name, kind: "landed", about_fork: null, symbol: null,
      message: `Landed at ${newHead.slice(0, 7)}.${goAround.length ? ` ${goAround.join(", ")} must go around (conflict).` : ""}`,
      data: { newHead }, dedupe_key: `landed:${winner.name}:${newHead}`,
    });
    this.syncDerivedSignals();
    this.syncAttemptSignals();
    await this.recheckAll(new Set([...goAround, ...finals]));
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
      chosenOver: (() => {
        const v = this.attemptVerdicts().get(f.name);
        return v?.kind === "chosen" ? v.over.map((o) => `${prLabel(o.fork)} (${this.relabel(o.reason)})`) : undefined;
      })(),
      review: this.reviewRequired()
        ? this.sql.exec<{ verdict: string; reviewer: string; note: string }>("SELECT verdict, reviewer, note FROM reviews WHERE fork = ? AND sha = ?", f.name, f.head_sha).toArray()[0]
        : undefined,
    });
  }

  private flightLogs(): FlightLogEntry[] {
    return flightLogs(this.sql);
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
    return overlaps(this.sql);
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
      await this.syncMainHead("reconcile");
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
    this.syncAttemptSignals(); // time alone can change a verdict (a sent-around pick's wait ends); one meta read if no tasks
    this.prune();
    if (this.notesPending()) this.ctx.waitUntil(this.writeNotes());
    return found;
  }

  /**
   * Storage stays bounded (issue #10): keep the newest events and snapshots, and drop resolved signals of PRs that are
   * no longer in flight once they're a week old (their story is already in the flight log). Never for a baseline whose
   * recorded run is published (ADR-0020) or kept for the video: pruning would cut its replay.
   */
  private prune() {
    const baseline = this.meta("baseline") ?? "";
    if (keptBaselines(this.env).has(baseline)) return;
    this.sql.exec("DELETE FROM event_log WHERE id <= (SELECT max(id) FROM event_log) - ?", KEEP_EVENTS);
    this.sql.exec("DELETE FROM snapshots WHERE id <= (SELECT max(id) FROM snapshots) - ?", KEEP_SNAPSHOTS);
    this.sql.exec(
      // Landed PRs only: their story is in the flight log. Abandoned ones have no log, so their signals are kept.
      "DELETE FROM signals WHERE resolved_at IS NOT NULL AND resolved_at < ? AND fork IN (SELECT name FROM forks WHERE status = 'landed')",
      Date.now() - 7 * 24 * 3600_000,
    );
  }

  /** Mark activity so the reconcile alarm keeps running; called on every API call and push. */
  touch() {
    this.setMeta("last_activity", String(Date.now()));
  }

  override async alarm(): Promise<void> {
    if (await this.reconcile()) this.touch();
    const idle = Date.now() - Number(this.meta("last_activity") ?? 0);
    // Notes are retried after the last landing too; once idle, any API call (ensure → scheduleReconcile) re-arms it.
    // Checks that ATC may still restart keep it running even when idle, or a hung run would wait for the next API call.
    const waiting = this.checksAwaitingRestart();
    if ((this.activeForks().length > 0 || this.notesPending()) && (idle < RECONCILE_IDLE_MS || waiting)) await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
    else this.log("reconcile.paused", { idleMs: idle });
  }

  /**
   * Any PR restartStuckChecks may still start again: pending or errored, retries left, and not a go-around (those are
   * skipped there, so they never use up restarts and would keep the alarm up forever; review of #31).
   */
  private checksAwaitingRestart(): boolean {
    const runs = new Map(this.sql.exec<CheckRun>("SELECT * FROM check_runs").toArray().map((r) => [r.fork, r]));
    const goAround = this.goAroundMap();
    const finals = this.finalLosers();
    // Pending at any restart count: after the last restart, the alarm must still be up for the final give-up (review of #31).
    return this.activeForks().some(
      (f) => !goAround.has(f.name) && !finals.has(f.name) && f.head_sha !== f.base_sha && (f.check_status === "pending" || (f.check_status === "error" && checkRetriesLeft(f, runs.get(f.name)))),
    );
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
    const head = this.meta("baseline_head");
    return readModel(this.sql, {
      baseline: this.meta("baseline"),
      baselineHead: head,
      approach: approachQueue(this.activeForks(), head ?? ""),
      reviewRequired: this.reviewRequired(),
      awaitingReview: [...this.reviewWaits().keys()],
      sequence: this.sequence(),
    });
  }
}

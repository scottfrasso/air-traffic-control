import { DurableObject } from "cloudflare:workers";
import { repoRef } from "../artifacts";
import type { Via } from "./identity";
import { computeVerdict } from "./policy";
import { ConfigError, parseCiConfig } from "./repoconfig";
import { REPO_MIGRATIONS, REPO_SCHEMA } from "./schema";
import { CHECK_NAMES, REVIEWERS, type Approval, type CheckName, type CheckRow, type Classification, type Finding, type Intent, type Pr, type PrState, type RawFinding, type ResolutionKind, type Reviewer, type StepStatus, type Verdict } from "./types";

/** What a RepoStore needs from the Worker's bindings (the generated Env has more). */
export interface StoreEnv {
  ARTIFACTS: Env["ARTIFACTS"];
  REVIEW_RUN: Workflow<ReviewRunParams>;
  CHECKER: Env["CHECKER"];
}

export interface ReviewRunParams {
  repo: string;
  pr: number;
  sha: string;
  run: number;
  /** Single checks: run only these (no classifier). Absent: the whole gauntlet. */
  only?: CheckName[];
}

export type RunRow = {
  id: number;
  pr: number;
  sha: string;
  number: number;
  status: "running" | "done" | "ci_failed" | "cancelled";
  since_sha: string | null;
  classification: string | null;
  ci_config: string | null;
  instance: string;
  scope: string | null;
  started_at: number;
  finished_at: number | null;
};

export type EventDetail = Record<string, string | number | boolean | null | string[]>;

export interface PrView {
  pr: Pr;
  run: RunRow | null;
  checks: CheckRow[];
  findings: Finding[];
  approvals: Approval[];
  verdict: Verdict;
  /** Flat JSON (RPC typing turns `unknown` into `never`). */
  events: Array<{ id: number; at: number; kind: string; detail: EventDetail }>;
}

export interface PrSummary {
  pr: Pr;
  verdict: Verdict;
  run: { number: number; sha: string; status: RunRow["status"]; startedAt: number; finishedAt: number | null } | null;
  findings: { important: number; nit: number };
  steps: Array<{ name: string; kind: CheckRow["kind"]; status: CheckRow["status"] }>;
  updatedAt: number;
}

type PrRow = Omit<Pr, "intent" | "createdAt" | "currentRun"> & { intent: string; created_at: number; current_run: number | null };
type FindingRow = Omit<Finding, "resolution" | "suggestion"> & { suggestion: string | null; res_kind: string | null; res_reason: string | null; res_by: string | null };

const EMPTY_INTENT: Intent = { what: "", why: "", testing: "", risk: "", revert: "" };
const OPEN_STATES = ["draft", "ready"];

/** Workflows refuses an instance id that already exists (code 10405): a duplicate start, not a failure. */
const isDuplicateInstance = (message: string) => /10405|already[ _]exists/i.test(message);

/**
 * One per repo (addressed by repo name). The only writer of PR state: PRs, review runs, checks, findings,
 * approvals and the event log. A review run writes through the record* methods, which refuse (return false) once
 * the run is no longer the PR's current one, so a cancelled run's late results never land on a newer head.
 */
export class RepoStore extends DurableObject<StoreEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(REPO_SCHEMA);
    for (const m of REPO_MIGRATIONS) {
      const has = this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${m.table}')`).toArray().some((c) => c.name === m.column);
      if (!has) this.sql.exec(m.ddl);
    }
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private get repo(): string {
    const r = this.meta("repo");
    if (!r) throw new Error("repo store not initialised; call init(repo) first");
    return r;
  }

  async init(repo: string): Promise<void> {
    if (this.meta("repo") === repo) return;
    this.sql.exec("INSERT INTO meta(key, value) VALUES ('repo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", repo);
  }

  private log(kind: string, pr: number | null, detail: unknown) {
    this.sql.exec("INSERT INTO events(at, pr, kind, detail) VALUES (?, ?, ?, ?)", Date.now(), pr, kind, JSON.stringify(detail));
  }

  private async headOf(branch: string): Promise<string | null> {
    using repo = await this.env.ARTIFACTS.get(this.repo);
    return (await repo.log({ ref: branch, limit: 1 }))[0]?.hash ?? null;
  }

  // ── PRs ──────────────────────────────────────────────────────────────

  private row(id: number): PrRow | null {
    return this.sql.exec<PrRow>("SELECT * FROM prs WHERE id = ?", id).toArray()[0] ?? null;
  }

  private toPr(r: PrRow): Pr {
    const { intent, created_at, current_run, ...rest } = r;
    return { ...rest, intent: { ...EMPTY_INTENT, ...(JSON.parse(intent) as Partial<Intent>) }, createdAt: created_at, currentRun: current_run };
  }

  private mustPr(id: number): PrRow {
    const r = this.row(id);
    if (!r) throw new Error(`no PR${id} in ${this.repo}`);
    return r;
  }

  async openPr(input: { title: string; author: string; source: string; target?: string; intent?: Partial<Intent> }): Promise<Pr> {
    const target = input.target ?? "main";
    if (input.source === target) throw new Error(`a PR can't merge ${target} into itself`);
    const taken = this.sql.exec("SELECT id FROM prs WHERE source = ? AND state IN ('draft', 'ready')", input.source).toArray()[0];
    if (taken) throw new Error(`branch ${input.source} already has an open PR (PR${taken.id})`);
    const [head, base] = await Promise.all([this.headOf(input.source), this.headOf(target)]);
    if (!head) throw new Error(`branch ${input.source} not found in ${this.repo}`);
    if (!base) throw new Error(`branch ${target} not found in ${this.repo}`);
    this.sql.exec(
      "INSERT INTO prs(title, author, source, target, state, head, base, intent, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)",
      input.title, input.author, input.source, target, head, base, JSON.stringify({ ...EMPTY_INTENT, ...(input.intent ?? {}) }), Date.now(),
    );
    const id = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    this.log("pr.opened", id, { by: input.author, source: input.source, target, head });
    return this.toPr(this.mustPr(id));
  }

  async listPrs(state?: PrState): Promise<Pr[]> {
    const rows = state ? this.sql.exec<PrRow>("SELECT * FROM prs WHERE state = ? ORDER BY id DESC", state) : this.sql.exec<PrRow>("SELECT * FROM prs ORDER BY id DESC");
    return rows.toArray().map((r) => this.toPr(r));
  }

  /** Every PR with what a dashboard row shows: the verdict, finding counts, step statuses, and last activity. */
  async listSummaries(limit = 50): Promise<PrSummary[]> {
    // The most recently active PRs (an old PR with a fresh push still makes the cut).
    const ids = this.sql.exec<{ id: number }>("SELECT p.id FROM prs p LEFT JOIN events e ON e.pr = p.id GROUP BY p.id ORDER BY max(coalesce(e.at, p.created_at)) DESC LIMIT ?", limit).toArray();
    const out: PrSummary[] = [];
    for (const { id } of ids) {
      const v = await this.getPr(id);
      const open = v.findings.filter((f) => f.status === "open");
      out.push({
        pr: v.pr,
        verdict: v.verdict,
        run: v.run ? { number: v.run.number, sha: v.run.sha, status: v.run.status, startedAt: v.run.started_at, finishedAt: v.run.finished_at } : null,
        findings: { important: open.filter((f) => f.severity === "important").length, nit: open.filter((f) => f.severity !== "important").length },
        steps: v.checks.map((c) => ({ name: c.name, kind: c.kind, status: c.status })),
        updatedAt: v.events[0]?.at ?? v.pr.createdAt,
      });
    }
    return out;
  }

  async getPr(id: number): Promise<PrView> {
    const r = this.mustPr(id);
    const pr = this.toPr(r);
    const run = r.current_run ? (this.sql.exec<RunRow>("SELECT * FROM runs WHERE id = ?", r.current_run).toArray()[0] ?? null) : null;
    const checks = run ? this.sql.exec<CheckRow>("SELECT * FROM checks WHERE run = ? ORDER BY rowid", run.id).toArray() : [];
    const findings = this.findings(id);
    const approvals = this.sql.exec<Approval>("SELECT * FROM approvals WHERE pr = ? ORDER BY at", id).toArray();
    const events = this.sql
      .exec<{ id: number; at: number; kind: string; detail: string }>("SELECT id, at, kind, detail FROM events WHERE pr = ? ORDER BY id DESC LIMIT 50", id)
      .toArray()
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) as EventDetail }));
    return { pr, run, checks, findings, approvals, verdict: this.verdict(pr, run, checks, findings, approvals), events };
  }

  private verdict(pr: Pr, run: RunRow | null, checks: CheckRow[], findings: Finding[], approvals: Approval[]): Verdict {
    const ci = checks.filter((c) => c.kind === "ci");
    const steps = checks.filter((c) => c.kind === "step");
    // The run records all CI results at once, before any step: so "all passed" means CI is done and green.
    const ciStatus: Verdict["ci"] =
      ci.some((c) => c.status === "failed" || c.status === "errored") ? "fail"
      : ci.length === 1 && ci[0]!.status === "skipped" ? "none"
      : ci.length && ci.every((c) => c.status === "passed") ? "pass"
      : "pending";
    return computeVerdict({
      state: pr.state,
      ci: run ? ciStatus : "pending",
      reviewDone: run?.status === "done",
      errored: steps.filter((s) => s.status === "errored").map((s) => s.name),
      open: findings.filter((f) => f.status === "open"),
      securityRan: steps.some((s) => s.name === "security" && s.status === "passed"),
      classification: run?.classification ? (JSON.parse(run.classification) as Classification) : null,
      approvals,
      head: pr.head,
      author: pr.author,
      run: run ? { sha: run.sha, finished: run.status !== "running", only: run.scope ? (JSON.parse(run.scope) as CheckName[]) : null } : null,
    });
  }

  private findings(pr: number): Finding[] {
    return this.sql
      .exec<FindingRow>("SELECT * FROM findings WHERE pr = ? ORDER BY id", pr)
      .toArray()
      .map(({ res_kind, res_reason, res_by, suggestion, ...f }) => ({
        ...f,
        ...(suggestion ? { suggestion } : {}),
        ...(res_kind ? { resolution: { kind: res_kind as ResolutionKind, reason: res_reason ?? "", by: res_by ?? "" } } : {}),
      }));
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  /** A push to any branch of this repo (from the queue). Open PRs on that branch move to the new head. */
  async onPush(ref: string, eventSha: string): Promise<void> {
    const branch = ref.replace(/^refs\/heads\//, "");
    const prs = this.sql.exec<PrRow>("SELECT * FROM prs WHERE source = ? AND state IN ('draft', 'ready')", branch).toArray();
    if (!prs.length) return;
    // Events can arrive late, twice or out of order: the branch's live head decides, not the event (review of PR #50).
    // A deleted branch has no head: leave its PR as it is (its merge will refuse).
    const sha = (await this.headOf(branch)) ?? null;
    if (!sha) {
      this.log("push.branch_missing", null, { branch, eventSha });
      return;
    }
    for (const p of prs) {
      if (p.head === sha) continue; // a redelivered or older event
      // Pushes are free: nothing starts or stops. A run in progress finishes and shows as stale (spec: triggered checks).
      this.sql.exec("UPDATE prs SET head = ? WHERE id = ?", sha, p.id);
      this.log("pr.pushed", p.id, { sha });
    }
  }

  /**
   * Run the checks (the gauntlet, or only some of it) on the PR's head: what an agent calls when its work is done.
   * A draft becomes ready. Asking again for a head that's being checked, or that a clean run already covered, returns
   * that run at no cost; a run that ended with a failure can be run again (flaky CI). Starting a new run cancels one
   * still going on an older head, since one run is in charge of a PR. Every state change happens before the first
   * await, so two calls at once start one run.
   */
  async runChecks(id: number, by: string, opts: { sha?: string; only?: CheckName[] } = {}): Promise<{ run: number }> {
    let p = this.mustPr(id);
    if (!OPEN_STATES.includes(p.state)) throw new Error(`PR${id} is ${p.state}`);
    for (const c of opts.only ?? []) if (!CHECK_NAMES.includes(c)) throw new Error(`unknown check ${c}: use ${CHECK_NAMES.join(", ")}`);
    const names = (sha: string) => (opts.sha!.length >= 7 ? sha.startsWith(opts.sha!) : sha === opts.sha);
    if (opts.sha && !names(p.head)) {
      // The push event may not have arrived yet (it comes through a queue): ask the branch itself (review of 10-17).
      const live = await this.headOf(p.source);
      p = this.mustPr(id);
      if (live && live !== p.head && names(live)) {
        this.sql.exec("UPDATE prs SET head = ? WHERE id = ?", live, id);
        this.log("pr.pushed", id, { sha: live });
        p = this.mustPr(id);
      }
      if (!names(p.head)) throw new Error(`PR${id} is at ${p.head}, not ${opts.sha}: push first, or name the head`);
    }
    const only = opts.only?.length ? CHECK_NAMES.filter((c) => opts.only!.includes(c)) : null;
    const scope = only ? JSON.stringify(only) : null;
    const cur = p.current_run ? this.runRow(p.current_run) : null;
    if (cur && cur.sha === p.head) {
      if (cur.status === "running" && cur.scope === scope) return { run: cur.id };
      if (cur.status === "done" && this.cleanRun(cur.id) && (cur.scope === scope || (cur.scope === null && this.covers(cur.id, only)))) return { run: cur.id };
    }
    if (p.state === "draft") {
      this.sql.exec("UPDATE prs SET state = 'ready' WHERE id = ?", id);
      this.log("pr.ready", id, { by });
    }
    const stopped = this.detachRun(id, "checks requested again");
    this.log("checks.requested", id, { by, sha: p.head, only: only ?? [] });
    const run = this.insertRun(id, only);
    if (stopped) await this.terminate(stopped);
    // If it can't start, the PR keeps the result it had (a finished run), not "never checked".
    await this.launch(id, run, only, cur && cur.status !== "running" ? cur.id : null);
    return { run };
  }

  /** No failed or errored check in it, CI at merge time included. */
  private cleanRun(run: number): boolean {
    return this.sql.exec("SELECT 1 FROM checks WHERE run = ? AND status IN ('failed', 'errored') LIMIT 1", run).toArray().length === 0;
  }

  /** A full run passed every requested single check: CI, and each reviewer that ran in it. */
  private covers(run: number, only: CheckName[] | null): boolean {
    if (!only) return true;
    const rows = this.sql.exec<{ name: string; kind: string; status: string }>("SELECT name, kind, status FROM checks WHERE run = ?", run).toArray();
    return only.every((c) => (c === "ci" ? rows.some((r) => r.kind === "ci" && r.status === "passed") : rows.some((r) => r.kind === "step" && r.name === c && r.status === "passed")));
  }

  /** The older name for runChecks (the whole gauntlet), kept for agents that call it. */
  async markReady(id: number, by: string): Promise<{ run: number }> {
    return this.runChecks(id, by);
  }

  async markDraft(id: number, by: string): Promise<void> {
    const p = this.mustPr(id);
    if (p.state !== "ready") return;
    this.sql.exec("UPDATE prs SET state = 'draft' WHERE id = ?", id);
    this.log("pr.draft", id, { by });
    await this.cancelRun(id, "back to draft");
  }

  async closePr(id: number, by: string): Promise<void> {
    const p = this.mustPr(id);
    if (!OPEN_STATES.includes(p.state)) return;
    await this.cancelRun(id, "closed");
    this.sql.exec("UPDATE prs SET state = 'closed' WHERE id = ?", id);
    this.log("pr.closed", id, { by });
  }

  /** A new run in charge of the PR (synchronous: no await, so concurrent callers see it). */
  private insertRun(id: number, only: CheckName[] | null): number {
    const p = this.mustPr(id);
    const number = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM runs WHERE pr = ?", id).one().n + 1;
    // Only a full run is a "last reviewed commit": a single check after it doesn't hide the change since (review of 10-17).
    const since = this.sql.exec<{ sha: string }>("SELECT sha FROM runs WHERE pr = ? AND status = 'done' AND scope IS NULL ORDER BY id DESC LIMIT 1", id).toArray()[0]?.sha ?? null;
    this.sql.exec("INSERT INTO runs(pr, sha, number, status, since_sha, instance, scope, started_at) VALUES (?, ?, ?, 'running', ?, '', ?, ?)", id, p.head, number, since, only ? JSON.stringify(only) : null, Date.now());
    const run = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    const instance = `${this.repo}-pr${id}-${p.head.slice(0, 12)}-r${run}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
    this.sql.exec("UPDATE runs SET instance = ? WHERE id = ?", instance, run);
    this.sql.exec("UPDATE prs SET current_run = ? WHERE id = ?", run, id);
    this.log("run.started", id, { run, sha: p.head, number });
    return run;
  }

  /** Start the run's Workflow; if that fails, remove the run and put `restore` (the previous result) back in charge. */
  private async launch(id: number, run: number, only: CheckName[] | null, restore: number | null): Promise<void> {
    const r = this.runRow(run)!;
    try {
      await this.env.REVIEW_RUN.create({ id: r.instance, params: { repo: this.repo, pr: id, sha: r.sha, run, ...(only ? { only } : {}) } });
    } catch (err) {
      if (!isDuplicateInstance((err as Error).message)) {
        // Leave nothing half-started: no run that will never report. Run checks again starts it.
        this.sql.exec("DELETE FROM runs WHERE id = ?", run);
        this.sql.exec("UPDATE prs SET current_run = ? WHERE id = ? AND current_run = ?", restore, id, run);
        this.log("run.start_failed", id, { run, error: (err as Error).message.slice(0, 300) });
        throw err;
      }
    }
  }

  /** The PR's run is no longer in charge; if it was still going, it's cancelled. Returns its instance to stop. */
  private detachRun(id: number, why: string): string | null {
    const p = this.mustPr(id);
    if (!p.current_run) return null;
    const run = this.runRow(p.current_run);
    this.sql.exec("UPDATE prs SET current_run = NULL WHERE id = ?", id);
    if (!run || run.status !== "running") return null;
    this.sql.exec("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?", Date.now(), run.id);
    this.log("run.cancelled", id, { run: run.id, why });
    return run.instance;
  }

  /** Best effort: correctness comes from record* refusing a non-current run, not from the terminate landing. */
  private async terminate(instance: string): Promise<void> {
    try {
      await (await this.env.REVIEW_RUN.get(instance)).terminate();
    } catch {
      /* already finished, or never started */
    }
  }

  private async cancelRun(id: number, why: string) {
    const stopped = this.detachRun(id, why);
    if (stopped) await this.terminate(stopped);
  }

  async approve(id: number, by: string, sha: string, via: Via): Promise<{ ok: boolean; error?: string }> {
    const p = this.mustPr(id);
    // Agents act with API tokens, and an agent's approval never counts as a person's (spec; review of PR #50).
    if (via !== "access") return { ok: false, error: "approve in the web UI, signed in through Cloudflare Access: an approval made with an API token could be an agent's" };
    if (p.state !== "ready") return { ok: false, error: `PR${id} is ${p.state}` };
    if (!sha || sha !== p.head) return { ok: false, error: `PR${id} is at ${p.head.slice(0, 7)}, not ${(sha || "(none)").slice(0, 7)}: review the current head` };
    this.sql.exec("INSERT OR IGNORE INTO approvals(pr, sha, by, at) VALUES (?, ?, ?, ?)", id, sha, by, Date.now());
    this.log("pr.approved", id, { by, sha });
    return { ok: true };
  }

  async resolveFinding(id: number, findingId: number, by: string, kind: ResolutionKind, reason: string, via: Via): Promise<{ ok: boolean; error?: string }> {
    const f = this.sql.exec<FindingRow>("SELECT * FROM findings WHERE id = ? AND pr = ?", findingId, id).toArray()[0];
    if (!f) return { ok: false, error: `no finding ${findingId} on PR${id}` };
    // A resolved important finding stops blocking: only a person may decide that, not the agent that has to fix it.
    if (f.severity === "important" && via !== "access") return { ok: false, error: "an important finding can only be resolved by a person in the web UI (signed in through Cloudflare Access); fix it with a push instead" };
    if (f.status !== "open") return { ok: false, error: `finding ${findingId} is ${f.status}` };
    if (!reason.trim()) return { ok: false, error: "a reason is required" };
    this.sql.exec("UPDATE findings SET status = 'resolved', res_kind = ?, res_reason = ?, res_by = ? WHERE id = ?", kind, reason.trim().slice(0, 500), by, findingId);
    this.log("finding.resolved", id, { finding: findingId, kind, by });
    return { ok: true };
  }

  // ── called by the review run ─────────────────────────────────────────

  private runRow(run: number): RunRow | null {
    return this.sql.exec<RunRow>("SELECT * FROM runs WHERE id = ?", run).toArray()[0] ?? null;
  }

  /** The run is still the one in charge of its PR. */
  private current(run: number): RunRow | null {
    const r = this.runRow(run);
    if (!r || r.status !== "running") return null;
    return this.row(r.pr)?.current_run === run ? r : null;
  }

  async runContext(run: number): Promise<{ current: boolean; pr: Pr; runNumber: number; lastReviewedSha: string | null; resolved: Array<{ file: string; class: string }>; open: Finding[]; previousClassification: Classification | null }> {
    const r = this.runRow(run);
    if (!r) throw new Error(`no run ${run}`);
    const findings = this.findings(r.pr);
    return {
      current: !!this.current(run),
      pr: this.toPr(this.mustPr(r.pr)),
      runNumber: r.number,
      lastReviewedSha: r.since_sha,
      resolved: findings.filter((f) => f.status === "resolved").map((f) => ({ file: f.file, class: f.class })),
      open: findings.filter((f) => f.status === "open"),
      previousClassification: (() => {
        const prev = this.sql.exec<{ classification: string | null }>("SELECT classification FROM runs WHERE pr = ? AND id < ? AND status = 'done' AND classification IS NOT NULL ORDER BY id DESC LIMIT 1", r.pr, run).toArray()[0];
        return prev?.classification ? (JSON.parse(prev.classification) as Classification) : null;
      })(),
    };
  }

  async recordCheck(run: number, c: CheckRow): Promise<boolean> {
    if (!this.current(run)) return false;
    this.sql.exec(
      "INSERT INTO checks(run, name, kind, status, log, ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run, name) DO UPDATE SET status = excluded.status, log = excluded.log, ms = excluded.ms, kind = excluded.kind",
      run, c.name, c.kind, c.status, c.log.slice(-8000), c.ms,
    );
    return true;
  }

  async recordStep(run: number, name: string, status: StepStatus, detail = ""): Promise<boolean> {
    return this.recordCheck(run, { run, name, kind: "step", status, log: detail, ms: 0 });
  }

  async recordClassification(run: number, c: Classification): Promise<boolean> {
    const r = this.current(run);
    if (!r) return false;
    this.sql.exec("UPDATE runs SET classification = ? WHERE id = ?", JSON.stringify(c), run);
    this.log("run.classified", r.pr, { run, tier: c.tier, needsHuman: c.needsHuman, reviewers: c.reviewers });
    return true;
  }

  /** Verified findings (and nits) from one reviewer. A re-reported open finding (same reviewer, file, class) is updated in place. */
  async recordFindings(run: number, reviewer: Reviewer, found: RawFinding[]): Promise<boolean> {
    const r = this.current(run);
    if (!r) return false;
    for (const f of found) {
      const same = this.sql.exec<{ id: number }>("SELECT id FROM findings WHERE pr = ? AND reviewer = ? AND file = ? AND class = ? AND status = 'open'", r.pr, reviewer, f.file, f.class).toArray()[0];
      if (same)
        this.sql.exec("UPDATE findings SET run = ?, sha = ?, line = ?, severity = ?, title = ?, evidence = ?, suggestion = ? WHERE id = ?", run, r.sha, f.line, f.severity, f.title, f.evidence, f.suggestion ?? null, same.id);
      else
        this.sql.exec(
          "INSERT INTO findings(pr, run, sha, reviewer, file, line, severity, class, title, evidence, suggestion, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')",
          r.pr, run, r.sha, reviewer, f.file, f.line, f.severity, f.class, f.title, f.evidence, f.suggestion ?? null,
        );
    }
    if (found.length) this.log("run.findings", r.pr, { run, reviewer, count: found.length });
    return true;
  }

  async recordCiConfig(run: number, text: string | null): Promise<boolean> {
    if (!this.current(run)) return false;
    this.sql.exec("UPDATE runs SET ci_config = ? WHERE id = ?", text, run);
    return true;
  }

  /** The PR's whole change for the web UI (the container's `diff` mode), cached per head commit. */
  async getDiff(id: number): Promise<{ sha: string; diff: string; changedPaths: string[] }> {
    const p = this.mustPr(id);
    const base = p.base ?? "";
    const hit = this.sql.exec<{ diff: string; paths: string }>("SELECT diff, paths FROM diffs WHERE sha = ? AND base = ?", p.head, base).toArray()[0];
    if (hit) return { sha: p.head, diff: hit.diff, changedPaths: JSON.parse(hit.paths) as string[] };
    const ref = await repoRef(this.env as unknown as Env, this.repo, "read", 900);
    const out = JSON.parse(
      await this.env.CHECKER.getByName(`review-${this.repo}`).run({ mode: "diff", repo: ref, branch: p.source, target: p.target, sha: p.head, base: p.base }),
    ) as { error?: string; diff: string; changedPaths: string[] };
    if (out.error) throw new Error(`diff failed: ${out.error}`);
    const diff = out.diff.length > 2_000_000 ? `${out.diff.slice(0, 2_000_000)}\n… (diff truncated at 2 MB)\n` : out.diff;
    this.sql.exec("INSERT OR REPLACE INTO diffs(sha, base, diff, paths) VALUES (?, ?, ?, ?)", p.head, base, diff, JSON.stringify(out.changedPaths));
    return { sha: p.head, diff, changedPaths: out.changedPaths };
  }

  // ── merge ────────────────────────────────────────────────────────────

  /**
   * Merge a mergeable PR: in the container, put its head onto the target's current head, run the PR's CI on that
   * exact commit, and fast-forward the target only if CI passes. If the target moved meanwhile, try once more on
   * its new head. One merge at a time per repo.
   */
  async merge(id: number, by: string): Promise<{ ok: true; sha: string } | { ok: false; blockers: string[] }> {
    const view = await this.getPr(id);
    if (!view.verdict.mergeable) return { ok: false, blockers: view.verdict.blockers };
    const lock = Number(this.meta("merging") ?? 0);
    if (lock > Date.now() - 30 * 60_000) return { ok: false, blockers: ["another merge is in progress; try again shortly"] };
    this.sql.exec("INSERT INTO meta(key, value) VALUES ('merging', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(Date.now()));
    try {
      const pr = view.pr;
      let commands: Array<{ name: string; run: string; timeoutSeconds: number }> = [];
      try {
        commands = parseCiConfig(view.run?.ci_config ?? null) ?? [];
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        return { ok: false, blockers: [err.message] };
      }
      const ref = await repoRef(this.env as unknown as Env, this.repo, "write", 1800);
      for (let attempt = 0; attempt < 2; attempt++) {
        const target = await this.headOf(pr.target);
        if (!target) return { ok: false, blockers: [`branch ${pr.target} not found`] };
        const res = JSON.parse(
          await this.env.CHECKER.getByName(`review-${this.repo}`).run({
            mode: "merge", repo: ref, source: pr.source, target: pr.target, expectedSource: pr.head, expectedTarget: target, message: `Merge PR${id}: ${pr.title}`, commands,
          }),
        ) as { error?: string; merged?: boolean; sha?: string; retry?: boolean; targetHead?: string; reason?: string; checks?: Array<{ name: string; status: string; log: string; ms: number }> };
        if (res.error) return { ok: false, blockers: [`merge failed: ${res.error}`] };
        if (res.merged && res.sha) {
          this.sql.exec("UPDATE prs SET state = 'merged' WHERE id = ?", id);
          this.log("pr.merged", id, { by, sha: res.sha, head: pr.head, onto: target });
          return { ok: true, sha: res.sha };
        }
        if (res.retry && res.targetHead && attempt === 0) continue; // the target moved: once more on its new head
        const failed = (res.checks ?? []).filter((c) => c.status !== "passed");
        if (failed.length && pr.currentRun)
          for (const c of res.checks ?? [])
            this.sql.exec("INSERT OR REPLACE INTO checks(run, name, kind, status, log, ms) VALUES (?, ?, 'ci', ?, ?, ?)", pr.currentRun, `merge: ${c.name}`, c.status, c.log.slice(-8000), c.ms);
        this.log("pr.merge_refused", id, { by, reason: res.reason ?? "merge refused" });
        return { ok: false, blockers: [res.reason ?? "merge refused"] };
      }
      return { ok: false, blockers: [`${pr.target} keeps moving; try again`] };
    } finally {
      this.sql.exec("DELETE FROM meta WHERE key = 'merging'");
    }
  }

  /** The run is over. After a full review, open findings from earlier runs that weren't re-reported are fixed. */
  async finishRun(run: number, outcome: "done" | "ci_failed"): Promise<boolean> {
    const r = this.current(run);
    if (!r) return false;
    this.sql.exec("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?", outcome, Date.now(), run);
    if (outcome === "done") {
      // Only a reviewer that ran and passed in this run can tell its earlier findings are gone (review of PR #50).
      const passed = this.sql
        .exec<{ name: string }>("SELECT name FROM checks WHERE run = ? AND kind = 'step' AND status = 'passed'", run)
        .toArray()
        .map((c) => c.name)
        .filter((n) => (REVIEWERS as readonly string[]).includes(n));
      // And only a full run on a different commit: a single check, or the same commit again, not reporting a finding
      // is the model varying, not a fix (review of 10-17).
      if (r.scope === null)
        for (const reviewer of passed) this.sql.exec("UPDATE findings SET status = 'fixed' WHERE pr = ? AND reviewer = ? AND status = 'open' AND run < ? AND sha != ?", r.pr, reviewer, run, r.sha);
    }
    this.log("run.finished", r.pr, { run, outcome });
    return true;
  }
}

import type { AgentClient, Role, SessionResult, SessionSpec } from "./agents/client";
import { classifierMessage, OUTPUT, reviewerMessage, verifierMessage } from "./agents/prompts";
import { applyHardRules, atLeast, effectiveReviewers, filterNew, tallyVotes } from "./policy";
import { ConfigError, parseCiConfig, parseOwners, parseReviewConfig, type CiCommand } from "./repoconfig";
import { InvalidOutput, parseClassification, parseReview, parseVotes } from "./schemas";
import type { RepoStore } from "./store";
import { REVIEWERS, type Classification, type Pr, type RawFinding, type Reviewer, type StepStatus } from "./types";

/**
 * One review run for one (PR, head commit), as plain orchestration over injected dependencies: the ReviewRun
 * Workflow passes the real ones (each call a durable step), tests pass fakes. Stages (spec, "Review run"):
 * snapshot → CI (gate) → classifier → reviewers in parallel → verifier votes → record → finish.
 * Every record call returns false once the run isn't the PR's current one (a newer push, back to draft): the run
 * then interrupts its sessions and stops, so nothing it learned lands on a newer head.
 */

export interface Snapshot {
  /** Uploaded once (agents.upload), mounted by every session: repo.tar.gz, diff.patch (the whole change), pr.json, and since.patch on follow-ups. */
  fileIds: Record<string, string>;
  changedPaths: string[];
  /** Config read from the head commit (null = file absent). */
  config: { ci: string | null; review: string | null; owners: string | null; reviewMd: string | null };
}

export type CiResult = { name: string; status: "passed" | "failed" | "errored" | "skipped"; log: string; ms: number };

export interface ReviewDeps {
  store: Pick<RepoStore, "runContext" | "recordCheck" | "recordStep" | "recordClassification" | "recordFindings" | "recordCiConfig" | "finishRun">;
  /** Build the snapshot of `sha` (diff against the PR's base, or against `since` on a follow-up run) and upload it. */
  snapshot(pr: Pr, sha: string, since: string | null): Promise<Snapshot>;
  ci(pr: Pr, commands: CiCommand[], sha: string): Promise<CiResult[]>;
  agents: AgentClient;
  /** A durable step in production (Workflow step.do); runs `fn` right away in tests. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
  limits?: { pollEveryMs: number; maxPolls: number };
}

export type Outcome = { outcome: "done" | "cancelled" | "ci_failed" | "failed" };

/** Poll after 10 s, then back off (doubling) to one poll a minute; 40 polls is about 35 minutes per session. */
const DEFAULT_LIMITS = { pollEveryMs: 10_000, maxPolls: 40 };
const MAX_POLL_EVERY_MS = 60_000;
/** Verifier sessions per reviewer per run: bounds cost; findings beyond it go up unverified (they still block). */
export const MAX_VERIFIED = 5;
/** Check that the run is still current every this many polls, so a cancelled run stops paying for sessions. */
const CURRENT_EVERY = 6;

class Cancelled extends Error {}

export async function runReview(deps: ReviewDeps, params: { repo: string; pr: number; sha: string; run: number }): Promise<Outcome> {
  const { run } = params;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const live = new Set<string>(); // sessions started and not yet finished
  let cancelled = false;
  /** Stop: interrupt every live session, then unwind (a reviewer's Cancelled rejects the Promise.all at once). */
  const cancel = async () => {
    if (!cancelled) {
      cancelled = true;
      await Promise.all([...live].map((id) => deps.agents.interrupt(id).catch(() => undefined)));
    }
    throw new Cancelled();
  };
  /** Every write goes through here: false from the store means this run is over. */
  const write = async (ok: Promise<boolean>) => {
    if (!(await ok)) await cancel();
  };
  const isCurrent = async () => (await deps.store.runContext(run)).current;
  let ciRecorded = false;

  try {
    const ctx = await deps.step("context", () => deps.store.runContext(run));
    if (!ctx.current) return { outcome: "cancelled" };
    const snap = await deps.step("snapshot", () => deps.snapshot(ctx.pr, params.sha, ctx.lastReviewedSha));
    await write(deps.store.recordCiConfig(run, snap.config.ci));
    const files = Object.entries(snap.fileIds).map(([name, fileId]) => ({ name, fileId }));
    const budgets = safe(() => parseReviewConfig(snap.config.review).budgets, parseReviewConfig(null).budgets);

    // ── CI gate ──
    let ciSummary: string;
    let commands: CiCommand[] | null;
    try {
      commands = parseCiConfig(snap.config.ci);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      await write(deps.store.recordCheck(run, { run, name: "ci config", kind: "ci", status: "failed", log: err.message, ms: 0 }));
      ciRecorded = true;
      await write(deps.store.finishRun(run, "ci_failed"));
      return { outcome: "ci_failed" };
    }
    if (commands === null) {
      await write(deps.store.recordCheck(run, { run, name: "ci", kind: "ci", status: "skipped", log: "no CI configured", ms: 0 }));
      ciRecorded = true;
      ciSummary = "no CI configured";
    } else {
      const cmds = commands;
      const results = await deps.step("ci", () => deps.ci(ctx.pr, cmds, params.sha));
      for (const r of results) await write(deps.store.recordCheck(run, { run, name: r.name, kind: "ci", status: r.status, log: r.log, ms: r.ms }));
      ciRecorded = true;
      if (results.some((r) => r.status !== "passed")) {
        await write(deps.store.finishRun(run, "ci_failed"));
        return { outcome: "ci_failed" };
      }
      ciSummary = `all ${results.length} commands passed (${results.map((r) => r.name).join(", ")})`;
    }

    /** Start a session, poll it to the end. Session failures come back as results, never as throws. */
    const session = async (name: string, spec: SessionSpec): Promise<SessionResult> => {
      let id: string;
      try {
        id = await deps.step(`${name}: start`, () => deps.agents.start(spec));
      } catch (err) {
        return { status: "errored", outputs: {}, error: `could not start: ${(err as Error).message.slice(0, 200)}` };
      }
      live.add(id);
      try {
        for (let i = 0; i < limits.maxPolls; i++) {
          if (cancelled) await cancel();
          let r: Awaited<ReturnType<AgentClient["poll"]>>;
          try {
            r = await deps.step(`${name}: poll ${i}`, () => deps.agents.poll(id, OUTPUT[spec.role]));
          } catch (err) {
            if (err instanceof Cancelled) throw err;
            await deps.agents.interrupt(id).catch(() => undefined);
            return { status: "errored", outputs: {}, error: `polling failed: ${(err as Error).message.slice(0, 200)}` };
          }
          if (r !== "running") return r;
          if ((i + 1) % CURRENT_EVERY === 0 && !(await isCurrent())) await cancel();
          await deps.sleep(`${name}: wait ${i}`, Math.min(limits.pollEveryMs * 2 ** i, MAX_POLL_EVERY_MS));
        }
        await deps.agents.interrupt(id).catch(() => undefined);
        return { status: "errored", outputs: {}, error: `timed out after ${limits.maxPolls} polls` };
      } finally {
        live.delete(id);
      }
    };
    const failure = (r: SessionResult) => r.error ?? `session ${r.status}`;
    const spec = (role: Role, message: string, budgetCents: number, extra: SessionSpec["files"] = []): SessionSpec => ({
      role, message, budgetCents, files: [...files, ...extra], title: `${params.repo} PR${params.pr} ${role}`,
    });

    // ── classifier ──
    const c = await session("classifier", spec("classifier", classifierMessage(ctx.pr, ciSummary, snap.changedPaths), budgets.classifier));
    let classification: Classification;
    let classifierStatus: StepStatus = "passed";
    let classifierDetail = "";
    try {
      if (c.status !== "done") throw new Error(failure(c));
      classification = parseClassification(c.outputs[OUTPUT.classifier] ?? "");
    } catch (err) {
      classifierStatus = "errored";
      classifierDetail = err instanceof InvalidOutput ? `invalid ${OUTPUT.classifier}: ${err.message}` : (err as Error).message;
      classification = { tier: "medium", needsHuman: true, humanReasons: [`classifier failed: ${classifierDetail.slice(0, 120)}`], reviewers: [...REVIEWERS], depth: "standard" };
    }
    await write(deps.store.recordStep(run, "classifier", classifierStatus, classifierDetail));
    classification = atLeast(ctx.previousClassification, applyHardRules(classification, snap.changedPaths, parseOwners(snap.config.owners)));
    classification = { ...classification, reviewers: effectiveReviewers(classification.reviewers, ctx.open.map((f) => f.reviewer), snap.changedPaths.length > 0) };
    await write(deps.store.recordClassification(run, classification));

    // ── reviewers, in parallel; each verifies its own important findings ──
    const reviewer = async (role: Reviewer) => {
      const message = reviewerMessage(role, ctx.pr, { ciSummary, reviewMd: snap.config.reviewMd, since: ctx.lastReviewedSha, open: ctx.open, depth: classification.depth });
      const r = await session(role, spec(role, message, budgets.reviewer));
      let found: RawFinding[];
      try {
        if (r.status !== "done") throw new Error(failure(r));
        found = filterNew(parseReview(r.outputs[OUTPUT[role]] ?? ""), ctx.resolved, ctx.runNumber);
      } catch (err) {
        await write(deps.store.recordStep(run, role, "errored", err instanceof InvalidOutput ? `invalid review.json: ${err.message}` : (err as Error).message));
        return;
      }
      const verified = await verify(role, found);
      await write(deps.store.recordFindings(run, role, verified.findings));
      await write(deps.store.recordStep(run, role, "passed", `${verified.findings.length} finding(s) posted, ${verified.dropped} dropped by verification`));
      if (verified.errored) await write(deps.store.recordStep(run, `verify ${role}`, "errored", verified.errored));
    };

    const verify = async (role: Reviewer, found: RawFinding[]) => {
      let errored = "";
      let dropped = 0;
      let important = 0;
      const out = await Promise.all(
        found.map(async (f, i): Promise<RawFinding | null> => {
          if (f.severity !== "important") return f; // nits and pre-existing go up unverified; they never block
          if (++important > MAX_VERIFIED) return { ...f, title: `[unverified] ${f.title}` };
          try {
            const fileId = await deps.step(`verify ${role} ${i}: upload`, () => deps.agents.upload("finding.json", JSON.stringify(f)));
            const v = await session(`verify ${role} ${i}`, spec("verifier", verifierMessage(role, f), budgets.verifier, [{ name: "finding.json", fileId }]));
            if (v.status !== "done") throw new Error(failure(v));
            const votes = parseVotes(v.outputs[OUTPUT.verifier] ?? "").map((x) => x.real);
            if (tallyVotes([votes])[0]) return f;
            dropped++;
            return null;
          } catch (err) {
            if (err instanceof Cancelled) throw err;
            errored ||= `verifier for "${f.title}" failed: ${(err as Error).message.slice(0, 160)}`;
            return { ...f, title: `[unverified] ${f.title}` };
          }
        }),
      );
      return { findings: out.filter((f): f is RawFinding => f !== null), dropped, errored };
    };

    await Promise.all(classification.reviewers.map((role) => reviewer(role)));
    await write(deps.store.finishRun(run, "done"));
    return { outcome: "done" };
  } catch (err) {
    if (err instanceof Cancelled) return { outcome: "cancelled" };
    // Anything else (container down, an archive over the cap, the agents API failing for good): stop paying for
    // sessions, say what broke, and finish the run, so the PR is never "in progress" forever (review of PR #50).
    const why = (err as Error).message?.slice(0, 500) ?? String(err);
    await Promise.all([...live].map((id) => deps.agents.interrupt(id).catch(() => undefined)));
    try {
      if (!ciRecorded) {
        await deps.store.recordCheck(run, { run, name: "ci", kind: "ci", status: "errored", log: `couldn't run: ${why}`, ms: 0 });
        await deps.store.finishRun(run, "ci_failed");
      } else {
        await deps.store.recordStep(run, "pipeline", "errored", why);
        await deps.store.finishRun(run, "done");
      }
    } catch {
      /* the store itself is failing: the Workflow's failure is the record */
    }
    return { outcome: "failed" };
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

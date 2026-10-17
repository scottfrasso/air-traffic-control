import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeAgentClient } from "../src/review/agents/fake";
import { runReview, type ReviewDeps, type Snapshot } from "../src/review/orchestrate";
import type { CheckRow, Classification, Finding, Pr, RawFinding, Reviewer, StepStatus } from "../src/review/types";

const PR: Pr = {
  id: 1, title: "Fix cart", author: "ann@x", source: "fix", target: "main", state: "ready", head: "h1", base: "m0", createdAt: 1, currentRun: 1,
  intent: { what: "fix totals", why: "bug", testing: "unit test", risk: "low", revert: "revert commit" },
};
const finding = (over: Partial<RawFinding> = {}): RawFinding => ({ file: "src/cart.ts", line: 4, severity: "important", class: "off-by-one", title: "skips last item", evidence: "i < n - 1", ...over });
const ok = (name: string, body: unknown) => ({ status: "done" as const, outputs: { [name]: JSON.stringify(body) } });

function harness(opts: { ci?: string | null; reviewYml?: string; owners?: string; runNumber?: number; open?: Finding[]; resolved?: Array<{ file: string; class: string }> } = {}) {
  const recorded = {
    checks: [] as CheckRow[],
    steps: new Map<string, { status: StepStatus; detail: string }>(),
    classification: null as Classification | null,
    findings: [] as Array<RawFinding & { reviewer: Reviewer }>,
    finished: null as string | null,
  };
  let current = true;
  const agents = new FakeAgentClient();
  const ciCalls: unknown[] = [];
  let ciResult: Array<{ name: string; status: "passed" | "failed" | "errored"; log: string; ms: number }> = [{ name: "test", status: "passed", log: "ok", ms: 3 }];
  const snapshotCalls: Array<{ base: string | null; sha: string; since: string | null }> = [];
  const deps: ReviewDeps = {
    store: {
      runContext: async () => ({ current, pr: PR, runNumber: opts.runNumber ?? 1, lastReviewedSha: (opts.runNumber ?? 1) > 1 ? "h0" : null, resolved: opts.resolved ?? [], open: opts.open ?? [] }),
      recordCheck: async (_run, c) => (current ? (recorded.checks.push(c), true) : false),
      recordStep: async (_run, name, status, detail = "") => (current ? (recorded.steps.set(name, { status, detail }), true) : false),
      recordClassification: async (_run, c) => (current ? ((recorded.classification = c), true) : false),
      recordFindings: async (_run, reviewer, fs) => (current ? (recorded.findings.push(...fs.map((f) => ({ ...f, reviewer }))), true) : false),
      finishRun: async (_run, outcome) => (current ? ((recorded.finished = outcome), true) : false),
    },
    snapshot: async (base, sha, since): Promise<Snapshot> => {
      snapshotCalls.push({ base, sha, since });
      const fileIds = { "repo.tar": await agents.upload("repo.tar", "TAR"), "diff.patch": await agents.upload("diff.patch", "+fix"), "pr.json": await agents.upload("pr.json", "{}") };
      return {
        fileIds, changedPaths: ["src/cart.ts"],
        config: { ci: opts.ci === undefined ? "commands:\n  - name: test\n    run: pnpm test\n" : opts.ci, review: opts.reviewYml ?? null, owners: opts.owners ?? null, reviewMd: "Watch money rounding." },
      };
    },
    ci: async (commands, sha) => (ciCalls.push({ commands, sha }), ciResult),
    agents,
    step: (_name, fn) => fn(),
    sleep: async () => undefined,
  };
  return {
    deps, agents, recorded, ciCalls, snapshotCalls,
    setCi: (r: typeof ciResult) => void (ciResult = r),
    cancel: () => void (current = false),
    run: () => runReview(deps, { repo: "shop", pr: 1, sha: "h1", run: 1 }),
  };
}

const classify = (reviewers: Reviewer[], over: Partial<Classification> = {}) => ok("classification.json", { tier: "low", needsHuman: false, humanReasons: [], reviewers, depth: "standard", ...over });
const votes = (...real: boolean[]) => ok("votes.json", { votes: real.map((r) => ({ findingIndex: 0, real: r, reason: "checked" })) });

test("failed CI ends the run: no agent session starts", async () => {
  const h = harness();
  h.setCi([{ name: "test", status: "failed", log: "1 failing", ms: 4 }]);
  assert.deepEqual(await h.run(), { outcome: "ci_failed" });
  assert.equal(h.agents.started.length, 0);
  assert.deepEqual(h.recorded.checks.map((c) => [c.name, c.kind, c.status]), [["test", "ci", "failed"]]);
  assert.equal(h.recorded.finished, "ci_failed");
});

test("no .atc/ci.yml: CI is recorded as not configured and the agents still run", async () => {
  const h = harness({ ci: null });
  h.agents.script("classifier", () => classify(["correctness"]));
  h.agents.script("correctness", () => ok("review.json", { findings: [] }));
  await h.run();
  assert.deepEqual(h.recorded.checks.map((c) => [c.name, c.status, c.log]), [["ci", "skipped", "no CI configured"]]);
  assert.equal(h.ciCalls.length, 0);
  assert.deepEqual(h.agents.started.map((s) => s.role), ["classifier", "correctness"]);
});

test("the classifier decides which reviewers run", async () => {
  const h = harness();
  h.agents.script("classifier", () => classify(["security"]));
  h.agents.script("security", () => ok("review.json", { findings: [] }));
  assert.deepEqual(await h.run(), { outcome: "done" });
  assert.deepEqual(h.agents.started.map((s) => s.role), ["classifier", "security"]);
  assert.equal(h.recorded.steps.get("security")?.status, "passed");
  assert.equal(h.recorded.finished, "done");
});

test("a classifier that fails runs every reviewer, needs a human, and marks its step errored", async () => {
  const h = harness();
  h.agents.script("classifier", () => ({ status: "done", outputs: { "classification.json": "not json" } }));
  for (const r of ["correctness", "security", "tests"] as const) h.agents.script(r, () => ok("review.json", { findings: [] }));
  await h.run();
  assert.deepEqual(h.agents.started.map((s) => s.role).sort(), ["classifier", "correctness", "security", "tests"]);
  assert.equal(h.recorded.steps.get("classifier")?.status, "errored");
  assert.equal(h.recorded.classification?.needsHuman, true);
  assert.equal(h.recorded.classification?.tier, "medium");
});

test("hard rules apply after the classifier: a listed owner path needs a human", async () => {
  const h = harness({ owners: "src/cart.ts\n" });
  h.agents.script("classifier", () => classify(["correctness"]));
  h.agents.script("correctness", () => ok("review.json", { findings: [] }));
  await h.run();
  assert.equal(h.recorded.classification?.needsHuman, true);
});

test("only findings that 2 of 3 verifier votes confirm are posted; nits go up unverified", async () => {
  const h = harness();
  h.agents.script("classifier", () => classify(["correctness"]));
  h.agents.script("correctness", () => ok("review.json", { findings: [finding(), finding({ class: "null-deref", file: "src/b.ts" }), finding({ severity: "nit", class: "naming" })] }));
  h.agents.script("verifier", (spec) => (h.agents.file(spec, "finding.json")!.includes("null-deref") ? votes(true, false, false) : votes(true, true, false)));
  await h.run();
  assert.deepEqual(h.recorded.findings.map((f) => [f.class, f.severity]).sort(), [["naming", "nit"], ["off-by-one", "important"]]);
  assert.equal(h.agents.started.filter((s) => s.role === "verifier").length, 2);
});

test("a reviewer's invalid review.json errors that reviewer only", async () => {
  const h = harness();
  h.agents.script("classifier", () => classify(["correctness", "tests"]));
  h.agents.script("correctness", () => ({ status: "done", outputs: { "review.json": "{\"findings\": [{\"file\": 1}]}" } }));
  h.agents.script("tests", () => ok("review.json", { findings: [finding({ class: "untested", severity: "nit" })] }));
  await h.run();
  assert.equal(h.recorded.steps.get("correctness")?.status, "errored");
  assert.match(h.recorded.steps.get("correctness")!.detail, /invalid review\.json/);
  assert.equal(h.recorded.steps.get("tests")?.status, "passed");
  assert.deepEqual(h.recorded.findings.map((f) => f.class), ["untested"]);
});

test("a reviewer that runs out of budget is errored with the reason", async () => {
  const h = harness();
  h.agents.script("classifier", () => classify(["security"]));
  h.agents.script("security", () => ({ status: "budget", outputs: {}, error: "budget reached" }));
  await h.run();
  assert.deepEqual(h.recorded.steps.get("security"), { status: "errored", detail: "budget reached" });
});

test("a session still running after the poll limit is errored as timed out", async () => {
  const h = harness();
  h.agents.runningPolls = 1_000;
  h.deps.limits = { pollEveryMs: 1, maxPolls: 3 };
  await h.run();
  assert.match(h.recorded.steps.get("classifier")!.detail, /timed out/);
});

test("cancelled after the classifier: no reviewer starts", async () => {
  const h = harness();
  h.agents.script("classifier", () => (h.cancel(), classify(["correctness"])));
  assert.deepEqual(await h.run(), { outcome: "cancelled" });
  assert.deepEqual(h.agents.started.map((s) => s.role), ["classifier"]);
});

test("cancelled while reviewers run: the others are interrupted and nothing is recorded", async () => {
  const h = harness();
  h.agents.script("classifier", () => classify(["correctness", "security"]));
  h.agents.script("correctness", () => (h.cancel(), ok("review.json", { findings: [finding({ severity: "nit" })] })));
  h.agents.script("security", () => new Promise(() => undefined)); // never answers
  assert.deepEqual(await h.run(), { outcome: "cancelled" });
  assert.equal(h.recorded.findings.length, 0);
  assert.ok(h.agents.interrupted.length >= 1);
});

test("a second run reviews the diff since the last reviewed commit and lists the open findings", async () => {
  const open: Finding = { ...finding(), id: 7, pr: 1, reviewer: "correctness", sha: "h0", run: 1, status: "open" };
  const h = harness({ runNumber: 2, open: [open] });
  h.agents.script("classifier", () => classify(["correctness"]));
  h.agents.script("correctness", () => ok("review.json", { findings: [] }));
  await h.run();
  assert.deepEqual(h.snapshotCalls, [{ base: "m0", sha: "h1", since: "h0" }]);
  const msg = h.agents.started.find((s) => s.role === "correctness")!.message;
  assert.match(msg, /changes since h0/);
  assert.match(msg, /off-by-one.*src\/cart\.ts/);
});

test("a finding the author resolved isn't posted again", async () => {
  const h = harness({ resolved: [{ file: "src/cart.ts", class: "off-by-one" }] });
  h.agents.script("classifier", () => classify(["correctness"]));
  h.agents.script("correctness", () => ok("review.json", { findings: [finding()] }));
  await h.run();
  assert.equal(h.recorded.findings.length, 0);
  assert.equal(h.agents.started.filter((s) => s.role === "verifier").length, 0);
});

test("budgets from .atc/review.yml are applied to each session", async () => {
  const h = harness({ reviewYml: "budgets:\n  classifier: 120\n  reviewer: 900\n" });
  h.agents.script("classifier", () => classify(["security"]));
  h.agents.script("security", () => ok("review.json", { findings: [] }));
  await h.run();
  assert.deepEqual(h.agents.started.map((s) => [s.role, s.budgetCents]), [["classifier", 120], ["security", 900]]);
});

test("a verifier that errors doesn't hide the finding: it's posted unverified and verification is errored", async () => {
  const h = harness();
  h.agents.script("classifier", () => classify(["correctness"]));
  h.agents.script("correctness", () => ok("review.json", { findings: [finding()] }));
  h.agents.script("verifier", () => ({ status: "errored", outputs: {}, error: "boom" }));
  await h.run();
  assert.match(h.recorded.findings[0]!.title, /^\[unverified\] /);
  assert.equal(h.recorded.steps.get("verify correctness")?.status, "errored");
});

test("every session gets the snapshot files and no credential in its message", async () => {
  const h = harness();
  h.agents.script("classifier", () => classify(["correctness"]));
  h.agents.script("correctness", () => ok("review.json", { findings: [] }));
  await h.run();
  for (const s of h.agents.started) {
    assert.deepEqual(s.files.map((f) => f.name).sort(), ["diff.patch", "pr.json", "repo.tar"]);
    assert.doesNotMatch(s.message, /token|bearer/i);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./harness/store";

async function withPr(opts: { ready?: boolean } = {}) {
  const s = store();
  await s.init();
  s.heads.set("fix", "f1");
  const pr = await s.co.openPr({ title: "Fix cart", author: "ann@x", source: "fix" });
  if (opts.ready) await s.co.markReady(pr.id, "ann@x");
  return { s, pr };
}

test("a new PR is a draft at its branch's head, and starts nothing", async () => {
  const { s, pr } = await withPr();
  assert.deepEqual([pr.state, pr.head, pr.base, pr.target, pr.author], ["draft", "f1", "m0", "main", "ann@x"]);
  assert.equal(s.runs.length, 0);
});

test("opening a PR for a branch that doesn't exist is refused", async () => {
  const s = store();
  await s.init();
  await assert.rejects(s.co.openPr({ title: "x", author: "ann@x", source: "nope" }), /branch nope/);
});

test("a second open PR for the same branch is refused", async () => {
  const { s } = await withPr();
  await assert.rejects(s.co.openPr({ title: "again", author: "ann@x", source: "fix" }), /already has an open PR/);
});

test("a push to a draft PR moves its head and still runs nothing", async () => {
  const { s, pr } = await withPr();
  await s.push("fix", "f2");
  assert.equal((await s.co.getPr(pr.id)).pr.head, "f2");
  assert.equal(s.runs.length, 0);
});

test("marking ready starts one review run for the head commit", async () => {
  const { s, pr } = await withPr({ ready: true });
  assert.equal(s.runs.length, 1);
  assert.match(s.runs[0]!.id, /^shop-pr1-f1-r1$/);
  assert.deepEqual(s.runs[0]!.params, { repo: "shop", pr: pr.id, sha: "f1", run: 1 });
  const view = await s.co.getPr(pr.id);
  assert.equal(view.pr.state, "ready");
  assert.equal(view.verdict.review, "pending");
});

test("marking ready twice doesn't start a second run", async () => {
  const { s, pr } = await withPr({ ready: true });
  await s.co.markReady(pr.id, "ann@x");
  assert.equal(s.runs.length, 1);
});

test("a push to a ready PR cancels its run and starts one for the new head; the old run can't write", async () => {
  const { s, pr } = await withPr({ ready: true });
  const old = s.runs[0]!.params.run;
  await s.push("fix", "f2");
  assert.deepEqual(s.terminated, ["shop-pr1-f1-r1"]);
  assert.equal(s.runs.length, 2);
  assert.equal(s.runs[1]!.params.sha, "f2");
  assert.equal(await s.co.recordCheck(old, { run: old, name: "lint", kind: "ci", status: "passed", log: "", ms: 1 }), false);
  assert.equal(s.q("SELECT 1 FROM checks WHERE run = ?", old).length, 0);
});

test("back to draft cancels the run; its late results are dropped", async () => {
  const { s, pr } = await withPr({ ready: true });
  await s.co.markDraft(pr.id, "ann@x");
  assert.deepEqual(s.terminated, ["shop-pr1-f1-r1"]);
  assert.equal(await s.co.recordFindings(1, "correctness", [{ file: "a", line: 1, severity: "important", class: "c", title: "t", evidence: "e" }]), false);
  assert.equal((await s.co.getPr(pr.id)).findings.length, 0);
});

test("an approval must name the current head", async () => {
  const { s, pr } = await withPr({ ready: true });
  assert.deepEqual(await s.co.approve(pr.id, "bob@x", "f0", "access"), { ok: false, error: "PR1 is at f1, not f0: review the current head" });
  assert.deepEqual(await s.co.approve(pr.id, "bob@x", "f1", "access"), { ok: true });
});

test("an approval stops counting once the PR moves on", async () => {
  const { s, pr } = await withPr({ ready: true });
  await s.co.approve(pr.id, "bob@x", "f1", "access");
  await s.push("fix", "f2");
  const v = (await s.co.getPr(pr.id)).verdict;
  assert.equal(v.approvals, 0);
});

test("a finished clean run with green CI makes a low-tier PR mergeable", async () => {
  const { s, pr } = await withPr({ ready: true });
  const run = 1;
  await s.co.recordCheck(run, { run, name: "test", kind: "ci", status: "passed", log: "ok", ms: 5 });
  await s.co.recordClassification(run, { tier: "low", needsHuman: false, humanReasons: [], reviewers: ["correctness"], depth: "standard" });
  await s.co.recordStep(run, "correctness", "passed");
  assert.equal(await s.co.finishRun(run, "done"), true);
  const v = (await s.co.getPr(pr.id)).verdict;
  assert.deepEqual([v.ci, v.review, v.mergeable], ["pass", "clean", true]);
});

test("findings: recorded open; resolving one needs a reason; resolved ones are listed for the next run", async () => {
  const { s, pr } = await withPr({ ready: true });
  await s.co.recordFindings(1, "correctness", [{ file: "src/a.ts", line: 3, severity: "important", class: "off-by-one", title: "t", evidence: "e" }]);
  const [f] = (await s.co.getPr(pr.id)).findings;
  assert.equal(f!.status, "open");
  assert.deepEqual(await s.co.resolveFinding(pr.id, f!.id, "ann@x", "intentional", "", "access"), { ok: false, error: "a reason is required" });
  assert.deepEqual(await s.co.resolveFinding(pr.id, f!.id, "ann@x", "intentional", "boundary is exclusive by design", "access"), { ok: true });
  await s.push("fix", "f2");
  const ctx = await s.co.runContext(2);
  assert.deepEqual(ctx.resolved, [{ file: "src/a.ts", class: "off-by-one" }]);
  assert.equal(ctx.lastReviewedSha, null); // run 1 never finished
});

test("a later run that doesn't re-report an open finding marks it fixed; one it re-reports stays open (updated, not duplicated)", async () => {
  const { s, pr } = await withPr({ ready: true });
  const a = { file: "src/a.ts", line: 3, severity: "important" as const, class: "bug-a", title: "a", evidence: "e" };
  const b = { file: "src/b.ts", line: 9, severity: "important" as const, class: "bug-b", title: "b", evidence: "e" };
  await s.co.recordFindings(1, "correctness", [a, b]);
  await s.co.finishRun(1, "done");
  await s.push("fix", "f2");
  const ctx = await s.co.runContext(2);
  assert.equal(ctx.lastReviewedSha, "f1");
  assert.equal(ctx.runNumber, 2);
  assert.equal(ctx.open.length, 2);
  await s.co.recordFindings(2, "correctness", [{ ...b, line: 10 }]);
  await s.co.recordStep(2, "correctness", "passed");
  await s.co.finishRun(2, "done");
  const fs = (await s.co.getPr(pr.id)).findings;
  assert.deepEqual(fs.map((f) => [f.class, f.status, f.line]).sort(), [["bug-a", "fixed", 3], ["bug-b", "open", 10]]);
});

test("a CI-failed run doesn't mark anything fixed", async () => {
  const { s, pr } = await withPr({ ready: true });
  await s.co.recordFindings(1, "correctness", [{ file: "a", line: 1, severity: "important", class: "c", title: "t", evidence: "e" }]);
  await s.co.finishRun(1, "done");
  await s.push("fix", "f2");
  await s.co.recordCheck(2, { run: 2, name: "test", kind: "ci", status: "failed", log: "1 failing", ms: 3 });
  await s.co.finishRun(2, "ci_failed");
  assert.equal((await s.co.getPr(pr.id)).findings[0]!.status, "open");
  assert.equal((await s.co.getPr(pr.id)).verdict.ci, "fail");
});

test("a push to a branch with no PR is ignored", async () => {
  const s = store();
  await s.init();
  await s.push("other", "o1");
  assert.equal(s.runs.length, 0);
});

test("a PR can target a branch other than main", async () => {
  const s = store();
  await s.init();
  s.heads.set("release", "r0");
  s.heads.set("hotfix", "h1");
  const pr = await s.co.openPr({ title: "hotfix", author: "ann@x", source: "hotfix", target: "release" });
  assert.deepEqual([pr.target, pr.base], ["release", "r0"]);
});

test("listPrs filters by state", async () => {
  const { s } = await withPr({ ready: true });
  s.heads.set("other", "o1");
  await s.co.openPr({ title: "other", author: "bob@x", source: "other" });
  assert.deepEqual((await s.co.listPrs("draft")).map((p) => p.title), ["other"]);
  assert.equal((await s.co.listPrs()).length, 2);
});

/** A ready PR whose run finished clean on green CI (low tier): mergeable. */
async function mergeablePr() {
  const { s, pr } = await withPr({ ready: true });
  await s.co.recordCiConfig(1, "commands:\n  - name: test\n    run: pnpm test\n");
  await s.co.recordCheck(1, { run: 1, name: "test", kind: "ci", status: "passed", log: "", ms: 1 });
  await s.co.recordClassification(1, { tier: "low", needsHuman: false, humanReasons: [], reviewers: ["correctness"], depth: "standard" });
  await s.co.recordStep(1, "correctness", "passed");
  await s.co.finishRun(1, "done");
  return { s, pr };
}

test("merge is refused with the verdict's blockers", async () => {
  const { s, pr } = await withPr();
  assert.deepEqual(await s.co.merge(pr.id, "ann@x"), { ok: false, blockers: ["PR is a draft"] });
  assert.equal(s.checkerCalls.length, 0);
});

test("merge runs the PR's CI on the merged commit in the container, then marks the PR merged", async () => {
  const { s, pr } = await mergeablePr();
  const r = await s.co.merge(pr.id, "ann@x");
  assert.deepEqual(r, { ok: true, sha: "merged-f1" });
  const call = s.checkerCalls[0]!;
  assert.deepEqual([call.mode, call.source, call.target, call.expectedSource, call.expectedTarget], ["merge", "fix", "main", "f1", "m0"]);
  assert.deepEqual(call.commands, [{ name: "test", run: "pnpm test", timeoutSeconds: 300 }]);
  assert.deepEqual((call.repo as { token: string }).token, "write-token");
  assert.equal((await s.co.getPr(pr.id)).pr.state, "merged");
});

test("merge onto a target that moved meanwhile retries once on the new head", async () => {
  const { s, pr } = await mergeablePr();
  let calls = 0;
  s.checker = async (input) => {
    if (calls++ === 0) {
      s.heads.set("main", "m1");
      return { mode: "merge", merged: false, retry: true, reason: "main moved to m1", targetHead: "m1" }; // as container/check.ts answers
    }
    return { mode: "merge", merged: true, sha: `merged-onto-${String(input.expectedTarget)}`, checks: [] };
  };
  assert.deepEqual(await s.co.merge(pr.id, "ann@x"), { ok: true, sha: "merged-onto-m1" });
});

test("CI failing on the merged commit leaves the PR open and shows the failure", async () => {
  const { s, pr } = await mergeablePr();
  s.checker = async () => ({ mode: "merge", merged: false, reason: "CI failed on the merged commit", checks: [{ name: "test", status: "failed", log: "2 failing", ms: 9 }] });
  const r = await s.co.merge(pr.id, "ann@x");
  assert.deepEqual(r, { ok: false, blockers: ["CI failed on the merged commit"] });
  const view = await s.co.getPr(pr.id);
  assert.equal(view.pr.state, "ready");
  assert.equal(view.verdict.ci, "fail");
  assert.ok(view.checks.some((c) => c.name === "merge: test" && c.status === "failed"));
});

test("a merge conflict with the target is refused with the files", async () => {
  const { s, pr } = await mergeablePr();
  s.checker = async () => ({ mode: "merge", merged: false, reason: "merge conflict with main in src/a.ts", conflicts: ["src/a.ts"] });
  assert.deepEqual(await s.co.merge(pr.id, "ann@x"), { ok: false, blockers: ["merge conflict with main in src/a.ts"] });
});

test("the PR's diff comes from the container once per head commit, then from the cache", async () => {
  const { s, pr } = await withPr();
  s.checker = async (input) => ({ mode: "diff", diff: `diff for ${String(input.sha)}\n`, changedPaths: ["src/a.ts"] });
  assert.deepEqual(await s.co.getDiff(pr.id), { sha: "f1", diff: "diff for f1\n", changedPaths: ["src/a.ts"] });
  await s.co.getDiff(pr.id);
  assert.equal(s.checkerCalls.filter((c) => c.mode === "diff").length, 1);
  await s.push("fix", "f2");
  assert.equal((await s.co.getDiff(pr.id)).diff, "diff for f2\n");
  const call = s.checkerCalls.at(-1)!;
  assert.deepEqual([call.branch, call.target, call.base, (call.repo as { token: string }).token], ["fix", "main", "m0", "read-token"]);
});

test("a later run marks fixed only the findings of reviewers that ran and passed in it", async () => {
  const { s, pr } = await withPr({ ready: true });
  const sec = { file: "src/r.js", line: 1, severity: "important" as const, class: "injection", title: "s", evidence: "e" };
  const cor = { file: "src/c.js", line: 2, severity: "important" as const, class: "off-by-one", title: "c", evidence: "e" };
  await s.co.recordFindings(1, "security", [sec]);
  await s.co.recordFindings(1, "correctness", [cor]);
  await s.co.finishRun(1, "done");
  await s.push("fix", "f2");
  await s.co.recordStep(2, "correctness", "passed"); // security didn't run (or errored) in run 2
  await s.co.finishRun(2, "done");
  const byClass = Object.fromEntries((await s.co.getPr(pr.id)).findings.map((f) => [f.class, f.status]));
  assert.deepEqual(byClass, { injection: "open", "off-by-one": "fixed" });
});

test("runContext hands the next run the classification of the last finished one", async () => {
  const { s } = await withPr({ ready: true });
  await s.co.recordClassification(1, { tier: "high", needsHuman: true, humanReasons: ["changes .atc/ci.yml"], reviewers: ["correctness"], depth: "deep" });
  await s.co.finishRun(1, "done");
  await s.push("fix", "f2");
  assert.equal((await s.co.runContext(2)).previousClassification?.tier, "high");
});

test("an approval made with an API token doesn't count: agents use tokens, and an agent never approves", async () => {
  const { s, pr } = await withPr({ ready: true });
  const r = await s.co.approve(pr.id, "ann@x", "f1", "token");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /signed in through Cloudflare Access/);
  assert.equal((await s.co.getPr(pr.id)).approvals.length, 0);
});

test("an important finding can't be resolved with an API token (an agent can't dismiss its own finding); a nit can", async () => {
  const { s, pr } = await withPr({ ready: true });
  await s.co.recordFindings(1, "security", [{ file: "a", line: 1, severity: "important", class: "injection", title: "t", evidence: "e" }, { file: "b", line: 1, severity: "nit", class: "naming", title: "n", evidence: "e" }]);
  const [imp, nit] = (await s.co.getPr(pr.id)).findings;
  const refused = await s.co.resolveFinding(pr.id, imp!.id, "ann@x", "wrong", "not reachable", "token");
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /a person in the web UI/);
  assert.deepEqual(await s.co.resolveFinding(pr.id, nit!.id, "ann@x", "wontfix", "naming is fine", "token"), { ok: true });
  assert.deepEqual(await s.co.resolveFinding(pr.id, imp!.id, "ann@x", "wrong", "not reachable", "access"), { ok: true });
});

test("if the review Workflow can't be started, nothing is left half-started: ready again starts it", async () => {
  const s = store();
  await s.init();
  s.heads.set("fix", "f1");
  const pr = await s.co.openPr({ title: "x", author: "ann@x", source: "fix" });
  const create = (s as unknown as { co: { env: { REVIEW_RUN: { create: (o: unknown) => Promise<unknown> } } } }).co.env.REVIEW_RUN.create;
  (s.co as unknown as { env: { REVIEW_RUN: { create: unknown } } }).env.REVIEW_RUN.create = async () => { throw new Error("workflows unavailable"); };
  await assert.rejects(s.co.markReady(pr.id, "ann@x"), /workflows unavailable/);
  assert.equal((await s.co.getPr(pr.id)).run, null);
  assert.equal(s.q("SELECT 1 FROM runs").length, 0);
  (s.co as unknown as { env: { REVIEW_RUN: { create: unknown } } }).env.REVIEW_RUN.create = create;
  const { run } = await s.co.markReady(pr.id, "ann@x"); // the PR is ready but has no run: start one
  assert.equal(s.runs.length, 1);
  assert.equal((await s.co.getPr(pr.id)).run?.id, run);
});

test("a late or reordered push event can't move a PR back to an older commit; a branch delete is ignored", async () => {
  const { s, pr } = await withPr({ ready: true });
  await s.push("fix", "f2");
  const runs = s.runs.length;
  await s.co.onPush("refs/heads/fix", "f1"); // a redelivered older event; the branch is still at f2
  assert.equal((await s.co.getPr(pr.id)).pr.head, "f2");
  assert.equal(s.runs.length, runs);
  s.heads.delete("fix");
  await s.co.onPush("refs/heads/fix", "0".repeat(40));
  assert.equal((await s.co.getPr(pr.id)).pr.head, "f2");
  assert.equal(s.runs.length, runs);
});

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
  assert.deepEqual(await s.co.approve(pr.id, "bob@x", "f0"), { ok: false, error: "PR1 is at f1, not f0: review the current head" });
  assert.deepEqual(await s.co.approve(pr.id, "bob@x", "f1"), { ok: true });
});

test("an approval stops counting once the PR moves on", async () => {
  const { s, pr } = await withPr({ ready: true });
  await s.co.approve(pr.id, "bob@x", "f1");
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
  assert.deepEqual(await s.co.resolveFinding(pr.id, f!.id, "ann@x", "intentional", ""), { ok: false, error: "a reason is required" });
  assert.deepEqual(await s.co.resolveFinding(pr.id, f!.id, "ann@x", "intentional", "boundary is exclusive by design"), { ok: true });
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

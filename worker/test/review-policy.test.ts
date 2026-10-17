import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHardRules, computeVerdict, countApprovals, filterNew, mergeGate, requiredApprovals, tallyVotes, type VerdictInput } from "../src/review/policy";
import type { Approval, Classification, Finding, RawFinding } from "../src/review/types";

const cls = (over: Partial<Classification> = {}): Classification => ({ tier: "low", needsHuman: false, humanReasons: [], reviewers: ["correctness"], depth: "standard", ...over });
const ap = (by: string, sha = "h1"): Approval => ({ pr: 1, sha, by, at: 1 });
const raw = (over: Partial<RawFinding> = {}): RawFinding => ({ file: "src/a.ts", line: 1, severity: "important", class: "bug", title: "t", evidence: "e", ...over });
const open = (over: Partial<Finding> = {}): Finding => ({ ...raw(), id: 1, pr: 1, reviewer: "correctness", sha: "h1", run: 1, status: "open", ...over });
const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  state: "ready", ci: "pass", reviewDone: true, errored: [], open: [], securityRan: true, classification: cls(), approvals: [], head: "h1", author: "ann@x", ...over,
});

test("required approvals by tier: low 0, medium 1, high 2", () => {
  assert.deepEqual([requiredApprovals("low", false), requiredApprovals("medium", false), requiredApprovals("high", false)], [0, 1, 2]);
});

test("needsHuman raises a low-tier PR to one approval", () => {
  assert.equal(requiredApprovals("low", true), 1);
});

test("the author's own approval of the head satisfies a medium-tier PR", () => {
  assert.equal(countApprovals([ap("ann@x")], "h1", "ann@x", "medium").satisfied(1), true);
});

test("the author alone doesn't satisfy a high-tier PR, even with two approvals counted", () => {
  const c = countApprovals([ap("ann@x"), ap("bob@x")], "h1", "ann@x", "high");
  assert.equal(c.satisfied(2), true);
  assert.equal(countApprovals([ap("ann@x")], "h1", "ann@x", "high").satisfied(1), false);
});

test("the same person approving twice counts once", () => {
  assert.equal(countApprovals([ap("bob@x"), ap("bob@x")], "h1", "ann@x", "high").count, 1);
});

test("an approval for an older commit doesn't count", () => {
  assert.equal(countApprovals([ap("bob@x", "h0")], "h1", "ann@x", "medium").count, 0);
});

test("touching .atc/ci.yml always needs a human, and never lowers the tier", () => {
  const c = applyHardRules(cls({ tier: "medium" }), [".atc/ci.yml", "src/a.ts"], []);
  assert.equal(c.needsHuman, true);
  assert.equal(c.tier, "medium");
  assert.match(c.humanReasons.join(), /\.atc\/ci\.yml/);
});

test("a path listed in .atc/owners needs a human", () => {
  const c = applyHardRules(cls(), ["src/billing/charge.ts"], ["src/billing/**"]);
  assert.equal(c.needsHuman, true);
  assert.match(c.humanReasons.join(), /src\/billing\/charge\.ts.*src\/billing\/\*\*/);
});

test("a finding is real when at least 2 of 3 verifiers say so", () => {
  assert.deepEqual(tallyVotes([[true, true, false], [true, false, false]]), [true, false]);
});

test("a finding the author resolved is never posted again for the same file and class", () => {
  assert.deepEqual(filterNew([raw(), raw({ file: "src/b.ts" })], [{ file: "src/a.ts", class: "bug" }], 2).map((f) => f.file), ["src/b.ts"]);
});

test("from the 4th run, new nits are dropped but important findings kept", () => {
  const out = filterNew([raw({ severity: "nit" }), raw({ severity: "important", file: "src/c.ts" })], [], 4);
  assert.deepEqual(out.map((f) => f.severity), ["important"]);
});

test("clean review, green CI, low tier: mergeable with no approvals", () => {
  const v = computeVerdict(input());
  assert.equal(v.review, "clean");
  assert.equal(v.mergeable, true);
  assert.deepEqual(mergeGate(v), { ok: true, blockers: [] });
});

test("an open important finding blocks merge, and says how many", () => {
  const v = computeVerdict(input({ open: [open()] }));
  assert.equal(v.review, "findings");
  assert.equal(v.mergeable, false);
  assert.ok(v.blockers.includes("1 open important finding"), v.blockers.join("; "));
});

test("an open security finding marks security blocking", () => {
  const v = computeVerdict(input({ open: [open({ reviewer: "security" })] }));
  assert.equal(v.security, "blocking");
  assert.ok(v.blockers.includes("open security finding"), v.blockers.join("; "));
});

test("an errored reviewer makes the review incomplete: a human must approve before merge", () => {
  const v = computeVerdict(input({ errored: ["security"] }));
  assert.equal(v.review, "incomplete");
  assert.equal(v.needsHuman, true);
  assert.equal(v.mergeable, false);
  assert.match(v.humanReasons.join(), /security errored/);
  assert.equal(computeVerdict(input({ errored: ["security"], approvals: [ap("bob@x")] })).mergeable, true);
});

test("a draft PR is never mergeable", () => {
  const v = computeVerdict(input({ state: "draft" }));
  assert.equal(v.mergeable, false);
  assert.ok(v.blockers.includes("PR is a draft"));
});

test("failed CI blocks merge and skips the review", () => {
  const v = computeVerdict(input({ ci: "fail", reviewDone: false, classification: null }));
  assert.equal(v.review, "skipped");
  assert.ok(v.blockers.includes("CI failed"));
  assert.equal(v.mergeable, false);
});

test("a pre-existing important finding is shown but doesn't block", () => {
  assert.equal(computeVerdict(input({ open: [open({ severity: "pre-existing" })] })).mergeable, true);
});

test("no CI configured needs a human: mergeable only with a person's approval", () => {
  const v = computeVerdict(input({ ci: "none" }));
  assert.equal(v.needsHuman, true);
  assert.match(v.humanReasons.join(), /no CI configured/);
  assert.equal(v.mergeable, false);
  assert.equal(computeVerdict(input({ ci: "none", approvals: [ap("ann@x")] })).mergeable, true);
});

test("a high-tier PR approved only by its author lists the missing non-author reviewer", () => {
  const v = computeVerdict(input({ classification: cls({ tier: "high" }), approvals: [ap("ann@x"), ap("ann@x")] }));
  assert.equal(v.mergeable, false);
  assert.ok(v.blockers.some((b) => /needs 2 approvals, has 1/.test(b)), v.blockers.join("; "));
  assert.ok(v.blockers.some((b) => /someone other than the author/.test(b)), v.blockers.join("; "));
});

test("while the review runs, the PR isn't mergeable", () => {
  const v = computeVerdict(input({ reviewDone: false, classification: null }));
  assert.equal(v.review, "pending");
  assert.ok(v.blockers.includes("review in progress"));
});

test("a draft PR's only blocker is being a draft (its review hasn't started, it isn't 'in progress')", () => {
  assert.deepEqual(computeVerdict(input({ state: "draft", ci: "pending", reviewDone: false, classification: null })).blockers, ["PR is a draft"]);
});

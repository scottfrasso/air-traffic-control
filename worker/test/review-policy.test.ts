import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHardRules, atLeast, computeVerdict, countApprovals, dedupeAcross, filterNew, isReal, requiredApprovals, type VerdictInput } from "../src/review/policy";
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

test("the author's own approval of the head counts once; others count as non-authors", () => {
  assert.deepEqual(countApprovals([ap("ann@x")], "h1", "ann@x"), { count: 1, nonAuthor: 0 });
  assert.deepEqual(countApprovals([ap("ann@x"), ap("bob@x"), ap("bob@x")], "h1", "ann@x"), { count: 2, nonAuthor: 1 });
});

test("the same person approving twice counts once", () => {
  assert.equal(countApprovals([ap("bob@x"), ap("bob@x")], "h1", "ann@x").count, 1);
});

test("an approval for an older commit doesn't count", () => {
  assert.equal(countApprovals([ap("bob@x", "h0")], "h1", "ann@x").count, 0);
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
  assert.deepEqual([isReal([true, true, false]), isReal([true, false, false])], [true, false]);
});

test("a finding the author resolved is never posted again for the same file and class", () => {
  assert.deepEqual(filterNew([raw(), raw({ file: "src/b.ts" })], [{ file: "src/a.ts", class: "bug", line: 1, severity: "important" }], 2).map((f) => f.file), ["src/b.ts"]);
});

test("from the 4th run, new nits are dropped but important findings kept", () => {
  const out = filterNew([raw({ severity: "nit" }), raw({ severity: "important", file: "src/c.ts" })], [], 4);
  assert.deepEqual(out.map((f) => f.severity), ["important"]);
});

test("clean review, green CI, low tier: mergeable with no approvals", () => {
  const v = computeVerdict(input());
  assert.equal(v.review, "clean");
  assert.equal(v.mergeable, true);
  assert.deepEqual(v.blockers, []);
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

test("a follow-up run's classification never drops below the previous one", () => {
  const prev = cls({ tier: "high", needsHuman: true, humanReasons: ["changes .atc/ci.yml"] });
  const next = cls({ tier: "low", needsHuman: false, humanReasons: [], reviewers: ["tests"] });
  assert.deepEqual(atLeast(prev, next), { ...next, tier: "high", needsHuman: true, humanReasons: ["changes .atc/ci.yml"] });
  assert.deepEqual(atLeast(null, next), next);
  assert.equal(atLeast(cls({ tier: "low" }), cls({ tier: "medium" })).tier, "medium");
});

// Titles from the first live run (10-17): three reviewers reported the same bugs, and two different bugs sat on one line.
const rf = (file: string, line: number, cls: string, title: string, severity: RawFinding["severity"] = "important"): RawFinding => ({ file, line, class: cls, title, severity, evidence: "e" });

test("dedupeAcross keeps one finding per bug across reviewers, in the lane it belongs to", () => {
  const out = dedupeAcross({
    correctness: [
      rf("src/report.js", 18, "shell-injection", "User-supplied word and logFile concatenated into execSync shell command"),
      rf("src/cart.js", 13, "off-by-one", "discountedTotal loop skips the last line item"),
      rf("src/cart.js", 13, "float-money", "Price computed with floating-point (1 - percent/100) multiplication"),
    ],
    tests: [
      rf("src/cart.js", 13, "off-by-one", "discountedTotal skips the last cart line (loop bound items.length - 1)"),
      rf("test/cart.test.js", 1, "missing-test", "New exported functions discountedTotal and countMentionsFast have no tests; CI passing only covers subtotal"),
    ],
    security: [
      rf("src/report.js", 17, "command-injection", "User-controlled `word` and `logFile` concatenated into a shell command passed to execSync"),
      rf("src/cart.js", 14, "off-by-one", "discountedTotal loop skips the last line item"),
      rf("test/cart.test.js", 1, "missing-tests", "New exported functions discountedTotal and countMentionsFast have no tests"),
    ],
  });
  const titles = (r: "correctness" | "security" | "tests") => (out[r] ?? []).map((f) => f.class).sort();
  assert.deepEqual(titles("security"), ["command-injection"], "the injection stays with security, once");
  assert.deepEqual(titles("correctness"), ["float-money", "off-by-one"], "a different bug on the same line is kept");
  assert.deepEqual(titles("tests"), ["missing-test"], "the missing test stays with tests, once");
});

test("dedupeAcross never merges within one reviewer or across files", () => {
  const out = dedupeAcross({
    correctness: [rf("a.js", 1, "off-by-one", "loop skips the last item"), rf("a.js", 2, "off-by-one", "loop skips the last item")],
    security: [rf("b.js", 1, "off-by-one", "loop skips the last item")],
  });
  assert.equal(out.correctness!.length, 2);
  assert.equal(out.security!.length, 1);
});

test("dedupeAcross keeps the most severe report of a bug, before the lane it belongs to", () => {
  const out = dedupeAcross({
    correctness: [rf("src/db.ts", 10, "sql-injection", "User input concatenated into the SQL query", "important")],
    security: [rf("src/db.ts", 10, "sql-injection", "User input concatenated into the SQL query", "nit")],
  });
  assert.deepEqual([out.correctness!.length, out.security!.length], [1, 0]);
});

test("a resolved finding hides only the same bug near the same line, at the same or lower severity", () => {
  const resolved = [{ file: "src/api.ts", class: "missing-auth-check", line: 10, severity: "nit" as const }];
  const found = [
    rf("src/api.ts", 11, "missing-auth-check", "same nit again", "nit"),
    rf("src/api.ts", 12, "missing-auth-check", "a real bypass", "important"),
    rf("src/api.ts", 90, "missing-auth-check", "another place", "nit"),
  ];
  assert.deepEqual(filterNew(found, resolved, 1).map((f) => f.title), ["a real bypass", "another place"]);
});

test("the verdict carries what the UI shows as fields, not only as blocker text", () => {
  const v = computeVerdict({ state: "ready", ci: "pass", reviewDone: true, errored: [], open: [], securityRan: true, classification: { tier: "high", needsHuman: true, humanReasons: [], reviewers: ["correctness"], depth: "standard" }, approvals: [], head: "h", author: "ann@x" });
  assert.equal(v.needsNonAuthor, true);
  assert.equal(v.openImportant, 0);
});

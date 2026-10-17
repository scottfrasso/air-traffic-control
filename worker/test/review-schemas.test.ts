import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidOutput, parseClassification, parseReview, parseVotes } from "../src/review/schemas";

const finding = (over: Record<string, unknown> = {}) => ({
  file: "src/a.ts", line: 3, severity: "important", class: "off-by-one", title: "Loop skips the last item", evidence: "i < n - 1", ...over,
});

test("a valid classification parses", () => {
  const c = parseClassification(JSON.stringify({ tier: "medium", needsHuman: false, humanReasons: [], reviewers: ["correctness", "security"], depth: "standard" }));
  assert.deepEqual(c, { tier: "medium", needsHuman: false, humanReasons: [], reviewers: ["correctness", "security"], depth: "standard" });
});

test("a classification naming an unknown reviewer is rejected", () => {
  assert.throws(() => parseClassification(JSON.stringify({ tier: "low", needsHuman: false, humanReasons: [], reviewers: ["style"], depth: "quick" })), InvalidOutput);
});

test("a review keeps at most 5 nits, and every important finding", () => {
  const nits = Array.from({ length: 7 }, (_, i) => finding({ severity: "nit", line: i + 1 }));
  const out = parseReview(JSON.stringify({ findings: [finding(), ...nits] }));
  assert.equal(out.filter((f) => f.severity === "nit").length, 5);
  assert.equal(out.filter((f) => f.severity === "important").length, 1);
});

test("a finding without evidence is rejected", () => {
  assert.throws(() => parseReview(JSON.stringify({ findings: [finding({ evidence: "" })] })), /evidence/);
});

test("output that isn't JSON is rejected as InvalidOutput", () => {
  assert.throws(() => parseReview("I found two bugs!"), InvalidOutput);
});

test("JSON wrapped in a ```json fence is accepted (models do that)", () => {
  const out = parseReview("```json\n" + JSON.stringify({ findings: [finding()] }) + "\n```");
  assert.equal(out.length, 1);
});

test("verifier votes parse, one per finding index", () => {
  const three = [true, false, true].map((real, i) => ({ findingIndex: 0, real, reason: `look ${i}` }));
  assert.deepEqual(parseVotes(JSON.stringify({ votes: three })), three);
  assert.throws(() => parseVotes(JSON.stringify({ votes: [...three.slice(1), { findingIndex: 0, real: "yes", reason: "" }] })), InvalidOutput);
});

test("a verifier must cast exactly three votes; fewer is invalid output (the finding then goes up unverified)", () => {
  assert.throws(() => parseVotes(JSON.stringify({ votes: [] })), InvalidOutput);
  assert.throws(() => parseVotes(JSON.stringify({ votes: [{ findingIndex: 0, real: false, reason: "x" }] })), InvalidOutput);
});

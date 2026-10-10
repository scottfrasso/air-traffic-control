import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePair } from "../src/conflicts";
import type { PairResult, Typecheck } from "../src/checker";

const ok = (sha: string): Typecheck => ({ sha, ok: true, errors: [], output: "" });
const err = { file: "src/checkout.ts", line: 6, col: 31, code: "TS2345", message: "Argument of type 'number' is not assignable to parameter of type 'Discount'.", lineText: "return applyDiscount(price, 15);" };

test("merge-only typecheck failure is a semantic conflict naming the symbol and both forks", () => {
  const r: PairResult = { mode: "pair", a: "s--a", b: "s--b", aloneA: ok("a1"), aloneB: ok("b1"), merge: { clean: true, conflicts: [], typecheck: { sha: "m", ok: false, errors: [err], output: "" } } };
  const v = analyzePair(r, { "s--a": ["applyDiscount"], "s--b": [] });
  assert.equal(v.status, "semantic_conflict");
  assert.equal(v.symbol, "applyDiscount");
  assert.equal(v.changer, "s--a");
  assert.equal(v.user, "s--b");
});

test("errors a fork already has alone are not blamed on the merge", () => {
  const r: PairResult = { mode: "pair", a: "s--a", b: "s--b", aloneA: ok("a1"), aloneB: { sha: "b1", ok: false, errors: [err], output: "" }, merge: { clean: true, conflicts: [], typecheck: { sha: "m", ok: false, errors: [err], output: "" } } };
  assert.equal(analyzePair(r, { "s--a": ["applyDiscount"] }).status, "inherited_failure");
});

test("textual conflicts and clean merges", () => {
  const base = { mode: "pair" as const, a: "s--a", b: "s--b", aloneA: ok("a1"), aloneB: ok("b1") };
  assert.equal(analyzePair({ ...base, merge: { clean: false, conflicts: ["src/cart.ts"] } }, {}).status, "textual_conflict");
  assert.equal(analyzePair({ ...base, merge: { clean: true, conflicts: [], typecheck: ok("m") } }, {}).status, "clean");
});

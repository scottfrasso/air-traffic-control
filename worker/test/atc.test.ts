import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSequence, clearanceMessage, prLabel, type Conflict } from "../src/atc";
import type { ForkRow } from "../src/types";

const f = (n: number, over: Partial<ForkRow> = {}): ForkRow => ({
  name: `shop--pr${n}`, agent: `a${n}`, pr: n, status: "active", created_at: n, base_sha: "base", head_sha: `h${n}`, processed_sha: `h${n}`,
  diff_lines: 10, subscription_id: null, remote: "", land_requested_at: null, landed_at: null, check_status: "green", check_sha: `h${n}`, check_detail: null, ...over,
});
const conflicts = (pairs: Array<[number, number, string]>) => {
  const m = new Map<string, Conflict[]>();
  for (const [a, b, symbol] of pairs) {
    m.set(`shop--pr${a}`, [...(m.get(`shop--pr${a}`) ?? []), { other: `shop--pr${b}`, symbol }]);
    m.set(`shop--pr${b}`, [...(m.get(`shop--pr${b}`) ?? []), { other: `shop--pr${a}`, symbol }]);
  }
  return m;
};

test("prLabel", () => {
  assert.equal(prLabel("shop-1--pr12"), "PR12");
  assert.equal(prLabel("shop--alice"), "ALICE");
});

test("smallest clean diff is cleared; the rest follow; the conflict loser holds", () => {
  const seq = buildSequence([f(1, { diff_lines: 12 }), f(2, { diff_lines: 7 }), f(3, { diff_lines: 3 })], conflicts([[1, 2, "applyDiscount"]]), "base");
  assert.deepEqual(seq.map((e) => [e.pr, e.clearance]), [["PR3", "cleared"], ["PR2", "follow"], ["PR1", "hold"]]);
  assert.equal(seq[0]!.reason, "Cleared to land. No conflicts.");
  assert.equal(seq[2]!.reason, "Conflicts with PR2 on applyDiscount. Lands after PR2, then rebase.");
});

test("requesting landing moves a PR to the front and wins its conflict", () => {
  const seq = buildSequence([f(1, { diff_lines: 12, land_requested_at: 5 }), f(2, { diff_lines: 7 })], conflicts([[1, 2, "applyDiscount"]]), "base");
  assert.equal(seq[0]!.pr, "PR1");
  assert.match(seq[0]!.reason, /Beats PR2 on applyDiscount: requested landing first/);
  assert.equal(clearanceMessage(seq[1]!), "ATC: PR2, hold. Conflicts with PR1 on applyDiscount. Lands after PR1, then rebase.");
});

test("behind baseline → go around; red → fix; unchecked → checking", () => {
  const seq = buildSequence([f(1, { base_sha: "old" }), f(2, { check_status: "red", check_detail: "src/a.ts:1 TS1 boom" }), f(3, { check_status: "pending" })], new Map(), "base");
  const by = Object.fromEntries(seq.map((e) => [e.pr, e.clearance]));
  assert.deepEqual(by, { PR1: "go_around", PR2: "fix", PR3: "checking" });
});

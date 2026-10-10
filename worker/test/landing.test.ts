import { test } from "node:test";
import assert from "node:assert/strict";
import { approachQueue, landingOrder } from "../src/landing";
import type { ForkRow } from "../src/types";

const fork = (name: string, over: Partial<ForkRow> = {}): ForkRow => ({
  name, agent: name, pr: 0, status: "active", created_at: 1, base_sha: "base", head_sha: "h", processed_sha: "h", diff_lines: 10,
  subscription_id: null, remote: "", land_requested_at: null, landed_at: null, check_status: "green", check_sha: "h", check_detail: null, ...over,
});

test("requesting landing puts you ahead", () => {
  assert.ok(landingOrder(fork("a", { land_requested_at: 5 }), fork("b"), "base") < 0);
});
test("current and green beat behind or red", () => {
  assert.ok(landingOrder(fork("a"), fork("b", { base_sha: "old" }), "base") < 0);
  assert.ok(landingOrder(fork("a"), fork("b", { check_status: "red" }), "base") < 0);
});
test("ties go to the smaller diff", () => {
  assert.deepEqual(approachQueue([fork("big", { diff_lines: 40 }), fork("small", { diff_lines: 7 })], "base"), ["small", "big"]);
});
test("both requested and landable is a tie: the smaller diff wins", () => {
  assert.ok(landingOrder(fork("a", { land_requested_at: 1, diff_lines: 50 }), fork("b", { land_requested_at: 2, diff_lines: 5 }), "base") > 0);
});

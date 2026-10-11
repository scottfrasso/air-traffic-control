import { test } from "node:test";
import assert from "node:assert/strict";
import { approachQueue, CHECK_TIMEOUT_S, forksWaitingOnPairs, LANDING_LOCK_MS, landingOrder, mayRelease, outstandingPairs, parseLock, takeLock, type PairCheckRow } from "../src/landing";
import type { ForkRow } from "../src/types";

const fork = (name: string, over: Partial<ForkRow> = {}): ForkRow => ({
  name, agent: name, pr: 0, status: "active", created_at: 1, base_sha: "base", head_sha: "h", processed_sha: "h", diff_lines: 10,
  subscription_id: null, remote: "", land_requested_at: null, landed_at: null, check_status: "green", check_sha: "h", check_base: "base", check_detail: null, ...over,
});

test("requesting landing puts you ahead", () => {
  assert.ok(landingOrder(fork("a", { land_requested_at: 5 }), fork("b"), "base") < 0);
});
test("current and green beat behind or red", () => {
  assert.ok(landingOrder(fork("a"), fork("b", { check_base: "old" }), "base") < 0); // b not yet checked on current main
  assert.ok(landingOrder(fork("a"), fork("b", { check_status: "red" }), "base") < 0);
});
test("ties go to the smaller diff", () => {
  assert.deepEqual(approachQueue([fork("big", { diff_lines: 40 }), fork("small", { diff_lines: 7 })], "base"), ["small", "big"]);
});
test("both requested and landable is a tie: the smaller diff wins", () => {
  assert.ok(landingOrder(fork("a", { land_requested_at: 1, diff_lines: 50 }), fork("b", { land_requested_at: 2, diff_lines: 5 }), "base") > 0);
});

// ── landing lock (issue #3) ──

test("the landing lock outlives the checker timeout", () => {
  assert.ok(LANDING_LOCK_MS > CHECK_TIMEOUT_S * 1000);
});
test("a held lock blocks; an expired lock can be taken over; a stale owner cannot clear the new owner's lock", () => {
  const first = takeLock(null, 1_000, "one")!;
  assert.deepEqual(first, { token: "one", at: 1_000 });
  assert.equal(takeLock(first, 1_000 + LANDING_LOCK_MS - 1, "two"), null); // still held
  const second = takeLock(first, 1_000 + LANDING_LOCK_MS + 1, "two")!; // expired: taken over
  assert.equal(second.token, "two");
  assert.equal(mayRelease(second, "one"), false); // the slow first landing finishes: must not clear it
  assert.equal(mayRelease(second, "two"), true);
});
test("lock parsing round-trips and treats legacy or garbage values as free", () => {
  assert.deepEqual(parseLock(JSON.stringify({ token: "t", at: 5 })), { token: "t", at: 5 });
  assert.equal(parseLock(""), null);
  assert.equal(parseLock("1760000000000"), null);
  assert.equal(parseLock("{oops"), null);
});

// ── pair coverage (issue #5) ──

test("two near-simultaneous pushes: stale pair results don't count; the current-head pair must be checked", () => {
  const checks: PairCheckRow[] = [];
  let a = fork("a", { head_sha: "a1" });
  let b = fork("b", { head_sha: "b0" });
  assert.deepEqual(outstandingPairs([a, b], checks), [{ a: "a", b: "b", shaA: "a1", shaB: "b0" }]);
  // Both push again at about the same time; each pipeline's pair check saw the other's OLD head.
  a = { ...a, head_sha: "a2" };
  b = { ...b, head_sha: "b1" };
  checks.push({ fork_a: "a", fork_b: "b", sha_a: "a2", sha_b: "b0" }); // from a's pipeline
  checks.splice(0, 1, { fork_a: "a", fork_b: "b", sha_a: "a1", sha_b: "b1" }); // b's result overwrites the row
  assert.deepEqual(outstandingPairs([a, b], checks), [{ a: "a", b: "b", shaA: "a2", shaB: "b1" }]);
  assert.deepEqual([...forksWaitingOnPairs(outstandingPairs([a, b], checks))].sort(), ["a", "b"]);
  // The re-queued check for the current heads lands: nothing outstanding.
  checks.splice(0, 1, { fork_a: "a", fork_b: "b", sha_a: "a2", sha_b: "b1" });
  assert.deepEqual(outstandingPairs([a, b], checks), []);
});
test("forks with no pushed changes, or not active, need no pair checks", () => {
  const idle = fork("idle", { head_sha: "base" });
  const gone = fork("gone", { status: "landed", head_sha: "g1" });
  assert.deepEqual(outstandingPairs([fork("a", { head_sha: "a1" }), idle, gone], []), []);
});

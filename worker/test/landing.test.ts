import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approachQueue, CHECK_TIMEOUT_S, forksWaitingOnPairs, LANDING_LOCK_MS, landingOrder, mayRecordPairFailure, mayRelease, outstandingPairs, PAIR_RETRY_MS, pairResultIsCurrent,
  pairsToQueue, parseLock, takeLock, type PairCheckRow, type PairQueueRow,
} from "../src/landing";
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

/**
 * In-memory airspace that applies pair results and re-queues exactly as the Coordinator does, through the same
 * decision functions (the Coordinator itself needs the Workers runtime).
 */
function airspace(...names: string[]) {
  const forks = new Map(names.map((n) => [n, fork(n, { head_sha: `${n}0`, processed_sha: `${n}0` })]));
  const checks: PairCheckRow[] = [];
  const queue: PairQueueRow[] = [];
  const seenAt = new Map<string, number>();
  const all = () => [...forks.values()];
  return {
    push(n: string, sha: string, indexed = true, at = 0) {
      forks.set(n, { ...forks.get(n)!, head_sha: sha, processed_sha: indexed ? sha : forks.get(n)!.processed_sha });
      seenAt.set(n, at);
    },
    /** applyPair: record only results for both current heads. */
    result(a: string, shaA: string, b: string, shaB: string) {
      if (!pairResultIsCurrent(all(), a, shaA, b, shaB)) return false;
      const i = checks.findIndex((c) => c.fork_a === a && c.fork_b === b);
      const row = { fork_a: a, fork_b: b, sha_a: shaA, sha_b: shaB };
      if (i >= 0) checks[i] = row;
      else checks.push(row);
      return true;
    },
    /** requeuePairs: returns what would be started, and marks it queued. */
    requeue(now: number) {
      const indexing = new Map(all().filter((f) => f.processed_sha !== f.head_sha).map((f) => [f.name, seenAt.get(f.name) ?? 0] as const));
      const due = pairsToQueue(outstandingPairs(all(), checks), queue, now, indexing);
      for (const d of due) {
        const i = queue.findIndex((q) => q.fork_a === d.a && q.fork_b === d.b);
        const row = { fork_a: d.a, fork_b: d.b, sha_a: d.shaA, sha_b: d.shaB, queued_at: now };
        if (i >= 0) queue[i] = row;
        else queue.push(row);
      }
      return due;
    },
    waiting: () => forksWaitingOnPairs(outstandingPairs(all(), checks)),
  };
}

test("a late result from an older push can't overwrite the current one (review finding 1)", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.push("a", "a2");
  assert.equal(s.result("a", "a2", "b", "b0"), true); // the newer push's check finishes first
  assert.equal(s.result("a", "a1", "b", "b0"), false); // the slower, older one is dropped
  assert.deepEqual([...s.waiting()], []);
});

test("a result for a push ATC hasn't seen yet doesn't count; once seen, that pair is re-queued (review finding 2)", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.requeue(0);
  // The container fetched b1 before ATC heard about it: not current, so not recorded (and no signals were raised).
  assert.equal(s.result("a", "a1", "b", "b1"), false);
  s.push("b", "b1");
  assert.deepEqual([...s.waiting()].sort(), ["a", "b"]); // a can't be cleared yet
  assert.deepEqual(s.requeue(1), [{ a: "a", b: "b", shaA: "a1", shaB: "b1" }]); // queued at the new heads right away
  assert.equal(s.result("a", "a1", "b", "b1"), true);
  assert.deepEqual([...s.waiting()], []);
});

test("a lost pair check is re-queued after the retry window, not before", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  assert.equal(s.requeue(1_000).length, 1);
  assert.equal(s.requeue(1_000 + PAIR_RETRY_MS - 1).length, 0); // still in flight
  assert.equal(s.requeue(1_000 + PAIR_RETRY_MS + 1).length, 1); // no result: assume lost
});

test("partners wait while a push is indexed; a PR stuck in indexing gets its pairs checked directly (review findings)", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.push("b", "b1", false, 1_000); // b's push seen at t=1000, not indexed yet
  assert.deepEqual([...s.waiting()].sort(), ["a", "b"]); // a can't be cleared or land past an unchecked (a, b1)
  assert.deepEqual(s.requeue(2_000), []); // b's own push pipeline will queue it
  assert.deepEqual(s.requeue(1_000 + PAIR_RETRY_MS + 1), [{ a: "a", b: "b", shaA: "a1", shaB: "b1" }]); // stuck: check it anyway
  assert.equal(s.result("a", "a1", "b", "b1"), true);
  assert.deepEqual([...s.waiting()], []);
});

test("a failed duplicate check can't overwrite a real result at the same heads", () => {
  const real = [{ fork_a: "a", fork_b: "b", sha_a: "a1", sha_b: "b1", status: "clean" }];
  assert.equal(mayRecordPairFailure(real, "b", "b1", "a", "a1"), false);
  assert.equal(mayRecordPairFailure(real, "a", "a2", "b", "b1"), true); // different heads
  assert.equal(mayRecordPairFailure([{ ...real[0]!, status: "error" }], "a", "a1", "b", "b1"), true);
});

test("forks with no pushed changes, or not active, need no pair checks", () => {
  const idle = fork("idle", { head_sha: "base" });
  const gone = fork("gone", { status: "landed", head_sha: "g1" });
  assert.deepEqual(outstandingPairs([fork("a", { head_sha: "a1" }), idle, gone], []), []);
});

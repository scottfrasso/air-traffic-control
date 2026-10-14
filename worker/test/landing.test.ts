import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approachQueue, CHECK_TIMEOUT_S, forksWaitingOnPairs, LANDING_LOCK_MS, landGate, landingOrder, mayRelease, outstandingPairs, PAIR_ERROR_RETRY_MS, PAIR_MAX_ATTEMPTS,
  PAIR_RETRY_MS, pairAttempts, pairFailure, pairPartners, pairResultRow, pairsToQueue, parseLock, queuedPair, takeLock, type PairCheckRow, type PairQueueRow,
} from "../src/landing";
import { buildSequence } from "../src/atc";
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

// ── landing gate ──

test("the gate: go-around, then running checks, main moved, red, outstanding pairs, a rival ahead, then land", () => {
  const me = fork("me", { land_requested_at: 5 });
  const base = { me, baselineHead: "base", waitingOnPairs: false, rivals: [] };
  assert.deepEqual(landGate({ ...base, goAround: "Conflicts with PR1 (landed)." }), { kind: "deny", reason: "Conflicts with PR1 (landed).", signal: null });
  assert.equal(landGate({ ...base, me: { ...me, processed_sha: "old" } }).kind, "retry");
  assert.equal(landGate({ ...base, me: { ...me, check_status: "pending" } }).kind, "retry");
  assert.deepEqual(landGate({ ...base, baselineHead: "new" }), { kind: "retry", reason: "Main moved; re-checking your PR on the new main. Retry in a few seconds.", then: "recheck" });
  const red = landGate({ ...base, me: { ...me, check_status: "red", check_detail: "on main: x.ts(1,1): TS2345" } });
  assert.equal(red.kind === "deny" && red.signal, "rebase_required");
  assert.equal(landGate({ ...base, me: { ...me, check_status: "red", check_detail: "TS2345" } }).kind, "deny");
  assert.deepEqual(landGate({ ...base, waitingOnPairs: true }), { kind: "retry", reason: "Still checking your PR against the other open PRs; retry in a few seconds.", then: "requeue_pairs" });
  const rival = fork("rival", { land_requested_at: 1 });
  const ahead = landGate({ ...base, me: { ...me, land_requested_at: null }, rivals: [rival] });
  assert.equal(ahead.kind === "deny" && ahead.signal, "land_blocked");
  assert.deepEqual(landGate(base), { kind: "land" });
});

test("a PR never lands while a pair is still being checked, even when no rival is ahead", () => {
  const g = landGate({ me: fork("me", { land_requested_at: 1 }), baselineHead: "base", waitingOnPairs: true, rivals: [fork("later")] });
  assert.equal(g.kind, "retry");
});

// ── pair coverage (issue #5) ──

/**
 * In-memory airspace: the Coordinator's pair bookkeeping with arrays for its tables. Every decision goes through the
 * same landing.ts functions the Coordinator calls (checkPlan → pairPartners/queuedPair, applyPair → pairResultRow,
 * applyPairFailure → pairFailure, requeuePairs → outstandingPairs/pairsToQueue); only the storage is stubbed.
 */
function airspace(...names: string[]) {
  const forks = new Map(names.map((n) => [n, fork(n, { head_sha: `${n}0`, processed_sha: `${n}0` })]));
  const checks: PairCheckRow[] = [];
  const queue: PairQueueRow[] = [];
  const seenAt = new Map<string, number>();
  const all = () => [...forks.values()];
  const upsert = <T extends PairCheckRow>(rows: T[], row: T) => {
    const i = rows.findIndex((c) => c.fork_a === row.fork_a && c.fork_b === row.fork_b);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
  };
  return {
    checks,
    push(n: string, sha: string, indexed = true, at = 0) {
      forks.set(n, { ...forks.get(n)!, head_sha: sha, processed_sha: indexed ? sha : forks.get(n)!.processed_sha });
      seenAt.set(n, at);
    },
    /** checkPlan: the pairs a push pipeline will check, at the heads ATC knows right now. */
    plan(n: string, sha: string, now = 0) {
      const others = pairPartners(all(), n, sha);
      if (!others) return null;
      for (const o of others) upsert(queue, queuedPair(forks.get(n)!, o, now));
      return others.map((o) => ({ a: n, shaA: sha, b: o.name, shaB: o.head_sha }));
    },
    /** applyPair: record only results for both current heads. */
    result(a: string, shaA: string, b: string, shaB: string, status = "clean", now = 0) {
      const row = pairResultRow(all(), a, shaA, b, shaB, status, "{}", now);
      if (row) upsert(checks, row);
      return !!row;
    },
    /** applyPairFailure. */
    fail(a: string, shaA: string, b: string, shaB: string, now: number) {
      const f = pairFailure(all(), checks, a, shaA, b, shaB, "container timed out", now);
      if (f.record) upsert(checks, f.row);
      return f;
    },
    /** requeuePairs: returns what would be started, and marks it queued. */
    requeue(now: number) {
      const indexing = new Map(all().filter((f) => f.processed_sha !== f.head_sha).map((f) => [f.name, seenAt.get(f.name) ?? 0] as const));
      const due = pairsToQueue(outstandingPairs(all(), checks), queue, now, indexing);
      for (const d of due) upsert(queue, queuedPair(forks.get(d.a)!, forks.get(d.b)!, now));
      return due.map(({ a, b, shaA, shaB }) => ({ a, b, shaA, shaB }));
    },
    waiting: () => forksWaitingOnPairs(outstandingPairs(all(), checks)),
  };
}

test("two near-simultaneous pushes end with the pair of their current heads checked", () => {
  // Interleaving 1: a's pipeline plans before ATC has seen b's push, so it checks (a1, b0); b's pipeline plans after.
  for (const order of ["old-first", "new-first"] as const) {
    const s = airspace("a", "b");
    s.push("a", "a1");
    const planA = s.plan("a", "a1")!; // b is still at b0
    s.push("b", "b1");
    const planB = s.plan("b", "b1")!; // sees a1
    assert.deepEqual(planA, [{ a: "a", shaA: "a1", b: "b", shaB: "b0" }]);
    assert.deepEqual(planB, [{ a: "b", shaA: "b1", b: "a", shaB: "a1" }]);
    const results = [() => s.result("a", "a1", "b", "b0"), () => s.result("b", "b1", "a", "a1")];
    if (order === "new-first") results.reverse();
    const recorded = results.map((r) => r());
    assert.deepEqual(recorded, order === "old-first" ? [false, true] : [true, false]); // (a1, b0) is never recorded
    assert.deepEqual(s.checks.map((c) => [c.sha_a, c.sha_b]), [["a1", "b1"]]);
    assert.deepEqual([...s.waiting()], []);
    assert.deepEqual(s.requeue(1), []);
  }
  // Interleaving 2: both pipelines plan before the other push is indexed but after it is seen: both check (a1, b1).
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.push("b", "b1");
  assert.deepEqual(s.plan("a", "a1"), [{ a: "a", shaA: "a1", b: "b", shaB: "b1" }]);
  assert.equal(s.result("a", "a1", "b", "b1"), true);
  assert.equal(s.result("b", "b1", "a", "a1"), true); // the duplicate just overwrites with the same heads
  assert.deepEqual([...s.waiting()], []);
});

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

test("an errored pair check stays outstanding and is retried after a back-off, until it succeeds", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.plan("a", "a1", 0);
  const f = s.fail("a", "a1", "b", "b0", 10_000);
  assert.equal(f.record && f.attempts, 1);
  assert.equal(f.record && f.final, false);
  assert.deepEqual([...s.waiting()].sort(), ["a", "b"]); // never cleared on an error
  assert.deepEqual(s.requeue(10_000 + PAIR_ERROR_RETRY_MS - 1), []); // backing off
  assert.deepEqual(s.requeue(10_000 + PAIR_ERROR_RETRY_MS), [{ a: "a", b: "b", shaA: "a1", shaB: "b0" }]);
  assert.deepEqual(s.requeue(10_000 + PAIR_ERROR_RETRY_MS + 1), []); // in flight now
  assert.equal(s.result("a", "a1", "b", "b0", "semantic_conflict"), true);
  assert.deepEqual([...s.waiting()], []);
  assert.equal(s.checks[0]!.status, "semantic_conflict");
});

test("after PAIR_MAX_ATTEMPTS errors the pair counts as checked, so a broken checker can't block landing forever", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.plan("a", "a1", 0);
  let t = 0;
  for (let i = 1; i <= PAIR_MAX_ATTEMPTS; i++) {
    t += 1_000;
    const f = s.fail("a", "a1", "b", "b0", t);
    assert.equal(f.record && f.attempts, i);
    assert.equal(f.record && f.final, i === PAIR_MAX_ATTEMPTS);
    t += PAIR_ERROR_RETRY_MS;
    assert.equal(s.requeue(t).length, i === PAIR_MAX_ATTEMPTS ? 0 : 1);
  }
  assert.deepEqual([...s.waiting()], []);
});

test("a new push resets the attempts: the errors were for the old heads", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.fail("a", "a1", "b", "b0", 1_000);
  s.fail("a", "a1", "b", "b0", 2_000);
  s.push("a", "a2");
  const f = s.fail("a", "a2", "b", "b0", 3_000);
  assert.equal(f.record && f.attempts, 1);
});

test("a failed duplicate check can't overwrite a real result, and a failure for old heads is dropped", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.result("a", "a1", "b", "b0");
  assert.deepEqual(s.fail("b", "b0", "a", "a1", 1), { record: false, why: "has_result" });
  assert.deepEqual(s.fail("a", "a0", "b", "b0", 1), { record: false, why: "stale" });
  assert.equal(s.checks[0]!.status, "clean");
});

test("error rows written before retries existed (no attempt count) stay final", () => {
  assert.equal(pairAttempts({ fork_a: "a", fork_b: "b", sha_a: "1", sha_b: "2", status: "error", detail: JSON.stringify({ error: "x" }) }), PAIR_MAX_ATTEMPTS);
  assert.equal(pairAttempts({ fork_a: "a", fork_b: "b", sha_a: "1", sha_b: "2", status: "clean", detail: "{}" }), 0);
  const legacy = [{ fork_a: "a", fork_b: "b", sha_a: "a1", sha_b: "b1", status: "error", detail: JSON.stringify({ error: "x" }), checked_at: 1 }];
  assert.deepEqual(outstandingPairs([fork("a", { head_sha: "a1" }), fork("b", { head_sha: "b1" })], legacy), []);
});

test("forks with no pushed changes, or not active, need no pair checks", () => {
  const idle = fork("idle", { head_sha: "base" });
  const gone = fork("gone", { status: "landed", head_sha: "g1" });
  assert.deepEqual(outstandingPairs([fork("a", { head_sha: "a1" }), idle, gone], []), []);
  assert.deepEqual(pairPartners([fork("a", { head_sha: "a1" }), idle, gone], "a", "a1"), []);
  assert.equal(pairPartners([fork("a", { head_sha: "a2" })], "a", "a1"), null); // superseded
});

test("cleared is never given while a pair is outstanding, including an errored pair with retries left", () => {
  const s = airspace("a", "b");
  s.push("a", "a1");
  s.push("b", "b1");
  const forks = [fork("a", { head_sha: "a1", processed_sha: "a1", check_sha: "a1" }), fork("b", { head_sha: "b1", processed_sha: "b1", check_sha: "b1" })];
  const clearances = () => buildSequence(forks, new Map(), "base", new Map(), forksWaitingOnPairs(outstandingPairs(forks, s.checks))).map((e) => e.clearance);
  assert.deepEqual(clearances(), ["checking", "checking"]);
  s.fail("a", "a1", "b", "b1", 1);
  assert.deepEqual(clearances(), ["checking", "checking"]);
  s.result("a", "a1", "b", "b1");
  assert.ok(clearances().includes("cleared"));
});

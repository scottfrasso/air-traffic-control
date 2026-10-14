import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSequence } from "../src/atc";
import {
  CHECK_ERROR_RETRY_MS, CHECK_MAX_RESTARTS, CHECK_STUCK_MS, checkRetriesLeft, forksToRecheck, isDuplicateInstance, landGate, stuckCheck, type CheckRun,
} from "../src/landing";
import type { ForkRow } from "../src/types";

// Issue #2: a PR must never sit in "pending" forever.

const fork = (name: string, over: Partial<ForkRow> = {}): ForkRow => ({
  name, agent: name, pr: 0, status: "active", created_at: 1, base_sha: "base", head_sha: "h", processed_sha: "h", diff_lines: 10,
  subscription_id: null, remote: "", land_requested_at: null, landed_at: null, check_status: "green", check_sha: "h", check_base: "main1", check_detail: null, ...over,
});
const run = (over: Partial<CheckRun> = {}): CheckRun => ({ fork: "a", sha: "h", started_at: 0, restarts: 0, ...over });

test("main moving outside ATC re-checks every open PR not yet checked on the new main", () => {
  const forks = [
    fork("a"), // green on main1
    fork("b", { check_status: "pending" }), // its check ran on main1 and will be dropped as stale
    fork("c", { processed_sha: "old", check_sha: "old", check_status: "pending" }), // push still being indexed
    fork("d", { check_base: "main2" }), // already checked on main2
    fork("idle", { head_sha: "base", processed_sha: "base" }), // nothing pushed
    fork("gone", { status: "landed" }),
  ];
  assert.deepEqual(forksToRecheck(forks, "main2").map((f) => f.name), ["a", "b", "c"]);
  assert.deepEqual(forksToRecheck(forks, "main2", new Set(["a"])).map((f) => f.name), ["b", "c"]); // go-arounds are excluded by the caller
});

test("request_land on a pending PR checked on an old main starts a re-check instead of answering retry forever", () => {
  const me = fork("me", { check_status: "pending", check_base: "main1" });
  assert.deepEqual(landGate({ me, baselineHead: "main2", waitingOnPairs: false, rivals: [] }), {
    kind: "retry", reason: "Main moved; re-checking your PR on the new main. Retry in a few seconds.", then: "recheck",
  });
  // Pending on the current main (a re-check is running): plain retry.
  assert.equal(landGate({ me: { ...me, check_base: "main2" }, baselineHead: "main2", waitingOnPairs: false, rivals: [] }).kind, "retry");
});

test("a failed check pipeline shows as an error: retry while ATC still retries, then refused until a new push", () => {
  const me = fork("me", { check_status: "error", check_detail: "checker produced no result" });
  const retry = landGate({ me, baselineHead: "main1", waitingOnPairs: false, rivals: [], checkRetriesLeft: true });
  assert.equal(retry.kind, "retry");
  assert.match(retry.kind === "retry" ? retry.reason : "", /couldn't run your checks \(checker produced no result\)/);
  const denied = landGate({ me, baselineHead: "main1", waitingOnPairs: false, rivals: [], checkRetriesLeft: false });
  assert.deepEqual(denied.kind === "deny" && [denied.signal, /Push again/.test(denied.reason)], ["land_blocked", true]);
  // An error for an older head doesn't count: the new push's checks are simply running.
  assert.equal(landGate({ me: { ...me, check_sha: "older" }, baselineHead: "main1", waitingOnPairs: false, rivals: [] }).kind, "retry");
});

test("the sequence says the checks couldn't run, never 'checks running' forever", () => {
  const [e] = buildSequence([fork("a", { check_status: "error", check_detail: "container cold start timed out\nmore" })], new Map(), "main1");
  assert.equal(e!.clearance, "checking");
  assert.match(e!.reason, /couldn't run the checks \(container cold start timed out\)/);
});

test("a check pending too long is started again: a re-check if indexed, the full push pipeline if not", () => {
  const pending = fork("a", { check_status: "pending", check_base: "main1" });
  assert.equal(stuckCheck(pending, run({ started_at: 1_000 }), "main2", 1_000 + CHECK_STUCK_MS - 1), null); // still in time
  assert.deepEqual(stuckCheck(pending, run({ started_at: 1_000 }), "main2", 1_000 + CHECK_STUCK_MS), { restart: "recheck", attempt: 1 });
  const unindexed = fork("a", { processed_sha: "old", check_sha: "old", check_status: "pending" });
  assert.deepEqual(stuckCheck(unindexed, run({ started_at: 0 }), "main1", CHECK_STUCK_MS), { restart: "push", attempt: 1 });
});

test("an errored check is retried after a short back-off", () => {
  const errored = fork("a", { check_status: "error" });
  assert.equal(stuckCheck(errored, run({ started_at: 1_000 }), "main1", 1_000 + CHECK_ERROR_RETRY_MS - 1), null);
  assert.deepEqual(stuckCheck(errored, run({ started_at: 1_000, restarts: 1 }), "main1", 1_000 + CHECK_ERROR_RETRY_MS), { restart: "recheck", attempt: 2 });
});

test("after CHECK_MAX_RESTARTS ATC gives up: a pending check becomes an error, an errored one stays put", () => {
  const maxed = run({ restarts: CHECK_MAX_RESTARTS });
  assert.deepEqual(stuckCheck(fork("a", { check_status: "pending", check_base: "main1" }), maxed, "main2", CHECK_STUCK_MS), { giveUp: true });
  assert.equal(stuckCheck(fork("a", { check_status: "error" }), maxed, "main1", CHECK_STUCK_MS), null);
  assert.equal(checkRetriesLeft(fork("a"), maxed), false);
  assert.equal(checkRetriesLeft(fork("a", { head_sha: "h2" }), maxed), true); // a new push starts over
});

test("a new push resets the restarts; a PR with no run record (from before this change) is restarted at once", () => {
  const pushed = fork("a", { head_sha: "h2", processed_sha: "h2", check_sha: "h2", check_status: "pending" });
  assert.deepEqual(stuckCheck(pushed, run({ sha: "h", restarts: CHECK_MAX_RESTARTS, started_at: 0 }), "main1", CHECK_STUCK_MS), { restart: "recheck", attempt: 1 });
  assert.deepEqual(stuckCheck(fork("a", { check_status: "pending" }), undefined, "main1", CHECK_STUCK_MS), { restart: "recheck", attempt: 1 });
});

test("PRs with a current result, or nothing pushed, are never restarted", () => {
  assert.equal(stuckCheck(fork("a"), undefined, "main1", 1e12), null);
  assert.equal(stuckCheck(fork("a", { check_status: "red" }), undefined, "main1", 1e12), null);
  assert.equal(stuckCheck(fork("a", { head_sha: "base", processed_sha: "base" }), undefined, "main1", 1e12), null);
});

test("main moved and every check on the old main was dropped: nothing stays pending once the alarm runs", () => {
  const forks = ["a", "b", "c"].map((n) => fork(n, { check_status: "pending", check_base: "main1" }));
  const t0 = 10_000;
  // The re-checks were started at t0 but never reported back (e.g. lost); the alarm restarts every one of them.
  const actions = forks.map((f) => stuckCheck(f, run({ fork: f.name, started_at: t0 }), "main2", t0 + CHECK_STUCK_MS));
  assert.deepEqual(actions, forks.map(() => ({ restart: "recheck", attempt: 1 })));
});

test("only Workflows' 'instance already exists' counts as a duplicate start", () => {
  assert.equal(isDuplicateInstance("(instance.already_exists) An instance with this ID already exists. [code: 10405]"), true);
  assert.equal(isDuplicateInstance("Internal error: workflow binding unavailable"), false);
});

test("a result on an older main is re-checked without using up a restart, even after the cap (review of #30, finding 4)", () => {
  const greenOld = fork("a", { check_base: "main1" });
  assert.deepEqual(stuckCheck(greenOld, run({ restarts: CHECK_MAX_RESTARTS }), "main2", CHECK_STUCK_MS), { restart: "recheck", attempt: CHECK_MAX_RESTARTS });
  assert.deepEqual(stuckCheck(greenOld, run({ restarts: 1 }), "main2", CHECK_STUCK_MS), { restart: "recheck", attempt: 1 });
});

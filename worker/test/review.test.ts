import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSequence, clearanceMessage } from "../src/atc";
import { landGate, reviewWaits, type ReviewRow } from "../src/landing";
import type { ForkRow } from "../src/types";
import { airport } from "./harness/coordinator";

// Issue #16: an optional review gate. Off by default.

const fork = (name: string, over: Partial<ForkRow> = {}): ForkRow => ({
  name, agent: name, pr: 0, status: "active", created_at: 1, base_sha: "base", head_sha: `${name}1`, processed_sha: `${name}1`, diff_lines: 10,
  subscription_id: null, remote: "", land_requested_at: null, landed_at: null, check_status: "green", check_sha: `${name}1`, check_base: "main", check_detail: null, ...over,
});
const review = (fork: string, sha: string, verdict: ReviewRow["verdict"] = "approve", note = ""): ReviewRow => ({ fork, sha, verdict, reviewer: "rev", note, at: 1 });

test("off by default: nobody waits for review", () => {
  assert.equal(reviewWaits([fork("a")], [], false).size, 0);
});

test("on: a PR waits until its CURRENT head is approved; a new push needs a new approval", () => {
  assert.match(reviewWaits([fork("a")], [], true).get("a")!, /Waiting for review of a1/);
  assert.equal(reviewWaits([fork("a")], [review("a", "a1")], true).size, 0);
  assert.match(reviewWaits([fork("a", { head_sha: "a2" })], [review("a", "a1")], true).get("a")!, /older push/);
  assert.match(reviewWaits([fork("a")], [review("a", "a1", "request_changes", "add a test")], true).get("a")!, /Changes requested by rev: add a test/);
  assert.equal(reviewWaits([fork("idle", { head_sha: "base" })], [], true).size, 0); // nothing pushed, nothing to review
});

test("REVIEW replaces CLEARED for an unapproved PR, and doesn't hold up the PR behind it", () => {
  const forks = [fork("x", { diff_lines: 3 }), fork("y", { diff_lines: 7 })];
  const seq = buildSequence(forks, new Map(), "main", new Map(), new Set(), new Set(), new Map([["x", "Waiting for review of x1."]]));
  assert.deepEqual(seq.map((e) => [e.fork, e.clearance]), [["x", "review"], ["y", "cleared"]]);
  assert.equal(clearanceMessage(seq[0]!), "ATC: X, waiting for review. Waiting for review of x1.");
});

test("request_land waits (retry) for the review, after every other check has passed", () => {
  const me = fork("me", { land_requested_at: 1 });
  assert.deepEqual(landGate({ me, baselineHead: "main", waitingOnPairs: false, rivals: [], awaitingReview: "Waiting for review of me1." }), { kind: "retry", reason: "Waiting for review of me1." });
  assert.equal(landGate({ me: { ...me, check_status: "red", check_detail: "TS1" }, baselineHead: "main", waitingOnPairs: false, rivals: [], awaitingReview: "w" }).kind, "deny"); // red first
  assert.deepEqual(landGate({ me, baselineHead: "main", waitingOnPairs: false, rivals: [] }), { kind: "land" });
});

test("the Coordinator: gate on, review via the API, a new push resets it, and the note reaches the author", async () => {
  const a = airport();
  const F = "base-repo--pr1";
  await a.co.ensure("base-repo");
  a.addFork(F);
  a.heads.set(F, "a1");
  await a.co.onPush(F, "a1", "event");
  await a.co.setReviewRequired(true);
  a.q("UPDATE forks SET processed_sha = 'a1', check_status = 'green', check_sha = 'a1', check_base = 'main0'"); // checks passed
  assert.equal((await a.co.getClearance(F)).clearance, "review");
  const r = await a.co.review(F, "approve", "looks right", "reviewer-bot");
  assert.deepEqual([r.sha, r.verdict, r.clearance], ["a1", "approve", "cleared"]);
  assert.match(a.q<{ message: string }>("SELECT message FROM signals WHERE fork = ? AND kind = 'review' AND resolved_at IS NULL", F)[0]!.message, /reviewer-bot approved PR1 at a1: looks right/);
  a.heads.set(F, "a2");
  await a.co.onPush(F, "a2", "event"); // new code: the approval no longer covers it
  a.q("UPDATE forks SET processed_sha = 'a2', check_status = 'green', check_sha = 'a2', check_base = 'main0'");
  assert.equal((await a.co.getClearance(F)).clearance, "review");
  await assert.rejects(a.co.review("nope", "approve", "", "x"), /unknown or inactive/);
});

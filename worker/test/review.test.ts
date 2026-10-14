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
  assert.equal(JSON.parse(await a.co.stateJson()).reviewRequired, true);
  const r = await a.co.review(F, "approve", "looks right", "reviewer-bot", "a1");
  assert.ok(r.ok);
  assert.deepEqual([r.sha, r.verdict, r.clearance], ["a1", "approve", "cleared"]);
  assert.match(a.q<{ message: string }>("SELECT message FROM signals WHERE fork = ? AND kind = 'review' AND resolved_at IS NULL", F)[0]!.message, /reviewer-bot approved PR1 at a1: looks right/);
  a.heads.set(F, "a2");
  await a.co.onPush(F, "a2", "event"); // new code: the approval no longer covers it
  a.q("UPDATE forks SET processed_sha = 'a2', check_status = 'green', check_sha = 'a2', check_base = 'main0'");
  assert.equal((await a.co.getClearance(F)).clearance, "review");
  assert.equal((await a.co.review("nope", "approve", "", "x", "a2")).ok, false);
  // The old approval's signal is closed by the push: it was for older code (review of #38).
  assert.equal(a.q("SELECT * FROM signals WHERE fork = ? AND kind = 'review' AND resolved_at IS NULL", F).length, 0);
});

// ── review of #38 ──

test("a review names the head it read; one for an older head is refused, so a push during review can't be approved unseen", async () => {
  const a = airport();
  const F = "base-repo--pr1";
  await a.co.ensure("base-repo");
  a.addFork(F);
  a.heads.set(F, "abcdef1111");
  await a.co.onPush(F, "abcdef1111", "event");
  await a.co.setReviewRequired(true);
  a.heads.set(F, "fedcba2222");
  await a.co.onPush(F, "fedcba2222", "event"); // pushed while the reviewer was reading abcdef1
  const r = await a.co.review(F, "approve", "", "rev", "abcdef1");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /PR1 is at fedcba2, not abcdef1/);
  assert.equal(a.q("SELECT * FROM reviews").length, 0);
  assert.equal((await a.co.review(F, "approve", "", "rev", "fedcba2")).ok, true); // a short sha of the current head is fine
});

test("an unapproved rival that asked to land first doesn't hold up an approved PR it conflicts with (review of #38)", () => {
  const x = fork("x", { diff_lines: 3, land_requested_at: 1 }); // asked first, smaller: would normally win
  const y = fork("y", { diff_lines: 9 });
  const conflicts = new Map([["x", [{ other: "y", symbol: "s" }]], ["y", [{ other: "x", symbol: "s" }]]]);
  const seq = buildSequence([x, y], conflicts, "main", new Map(), new Set(), new Set(), new Map([["x", "Changes requested by rev."]]));
  assert.deepEqual(seq.map((e) => [e.fork, e.clearance]), [["x", "review"], ["y", "cleared"]]);
});

test("request_land with the gate on: retry until approved, then it lands; a fresh Coordinator has the gate off", async () => {
  const a = airport();
  const F = "base-repo--pr1";
  await a.co.ensure("base-repo");
  assert.equal(JSON.parse(await a.co.stateJson()).reviewRequired, false);
  a.addFork(F);
  a.heads.set(F, "a1");
  await a.co.onPush(F, "a1", "event");
  a.q("UPDATE forks SET processed_sha = 'a1', check_status = 'green', check_sha = 'a1', check_base = 'main0'");
  await a.co.setReviewRequired(true);
  const waiting = await a.co.requestLand(F);
  assert.deepEqual([waiting.landed, waiting.retry], [false, true]);
  assert.match(waiting.reason ?? "", /Waiting for review of a1/);
  await a.co.review(F, "approve", "", "rev", "a1");
  assert.equal((await a.co.requestLand(F)).landed, true);
});

// ── second review of #38 ──

test("when the beaten rival is only waiting for review, CLEARED says so (it goes into git notes)", () => {
  const x = fork("x", { diff_lines: 3, land_requested_at: 1 });
  const y = fork("y", { diff_lines: 9 });
  const conflicts = new Map([["x", [{ other: "y", symbol: "s" }]], ["y", [{ other: "x", symbol: "s" }]]]);
  const seq = buildSequence([x, y], conflicts, "main", new Map(), new Set(), new Set(), new Map([["x", "Waiting for review of x1."]]));
  assert.equal(seq.find((e) => e.fork === "y")!.reason, "Cleared to land. Beats X on s: X is waiting for review.");
});

test("through request_land: an approved PR lands past an unapproved rival that asked first; reviews and the gate switch wait during a landing", async () => {
  const a = airport();
  const [P1, P2] = ["base-repo--pr1", "base-repo--pr2"];
  await a.co.ensure("base-repo");
  for (const [n, sha] of [[P1, "a1"], [P2, "b1"]]) {
    a.addFork(n);
    a.heads.set(n, sha);
    await a.co.onPush(n, sha, "event");
  }
  a.q("UPDATE forks SET processed_sha = head_sha, check_status = 'green', check_sha = head_sha, check_base = 'main0'");
  a.q("UPDATE forks SET land_requested_at = 1, diff_lines = 3 WHERE name = ?", P1); // asked first, smaller
  a.q("INSERT INTO pair_checks(fork_a, fork_b, sha_a, sha_b, status, detail, checked_at) VALUES (?, ?, 'a1', 'b1', 'semantic_conflict', '{}', 1)", P1, P2);
  for (const [me, other] of [[P1, P2], [P2, P1]])
    (a.co as unknown as { emitSignal(s: object): void }).emitSignal({ fork: me, kind: "semantic_conflict", about_fork: other, symbol: "s", message: "m", data: {}, dedupe_key: `sem:${me}` });
  await a.co.setReviewRequired(true);
  await a.co.review(P2, "approve", "", "rev", "b1");
  // While P2's landing runs, a review (and switching the gate) is refused.
  let during: unknown[] = [];
  a.checker = async (input: { mode: string; fork?: { expectedHead?: string } }) => {
    if (input.mode === "land")
      during = [
        (await a.co.review(P2, "approve", "", "rev", "b1")).ok, // the PR being landed: refused
        (await a.co.setReviewRequired(false)).error,
      ];
    return input.mode === "land" ? { mode: "land", landed: true, landedSha: "landed-b1", forkHead: "b1", merged: true } : { mode: "notes", written: [] };
  };
  const res = await a.co.requestLand(P2);
  assert.equal(res.landed, true, res.reason);
  assert.deepEqual(during, [false, "a landing is in progress; try again in a few seconds"]);
  // Another PR's review isn't held up by this landing (review of #38).
  assert.equal(a.q("SELECT * FROM signals WHERE fork = ? AND kind = 'rebase_required' AND resolved_at IS NULL", P1).length, 1); // P1 goes around
});

test("during a landing, other PRs can still be reviewed; only the PR being landed is refused (review of #38)", async () => {
  const a = airport();
  const [P1, P2] = ["base-repo--pr1", "base-repo--pr2"];
  await a.co.ensure("base-repo");
  for (const [n, sha] of [[P1, "a1"], [P2, "b1"]]) {
    a.addFork(n);
    a.heads.set(n, sha);
    await a.co.onPush(n, sha, "event");
  }
  await a.co.setReviewRequired(true);
  a.q("INSERT INTO meta(key, value) VALUES ('landing', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ token: "t", at: Date.now(), fork: P2 }));
  assert.equal((await a.co.review(P1, "approve", "", "rev", "a1")).ok, true);
  assert.equal((await a.co.review(P2, "approve", "", "rev", "b1")).ok, false);
});

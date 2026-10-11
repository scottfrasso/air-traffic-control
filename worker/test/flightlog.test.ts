import { test } from "node:test";
import assert from "node:assert/strict";
import { clearanceHistory, flightLogNote, type FlightLogInput } from "../src/flightlog";

const B = "shop-1--pr2";
const A = "shop-1--pr1";
const snap = (at: number, clearance: string, reason = clearance) => ({ at, sequence: [{ fork: A, clearance: "cleared", reason: "x" }, { fork: B, clearance, reason }] });

test("clearance history keeps one step per change of clearance", () => {
  const h = clearanceHistory([snap(1, "checking"), snap(2, "checking", "Main moved."), snap(3, "hold", "Conflicts with PR1"), snap(4, "go_around"), snap(5, "checking"), snap(6, "cleared")], B);
  assert.deepEqual(h.map((c) => c.clearance), ["checking", "hold", "go_around", "checking", "cleared"]);
  assert.equal(h[1]!.reason, "Conflicts with PR1");
});

test("clearance history skips snapshots the PR isn't in", () => {
  assert.deepEqual(clearanceHistory([{ at: 1, sequence: [] }, snap(2, "follow")], B).map((c) => c.at), [2]);
});

const input = (over: Partial<FlightLogInput> = {}): FlightLogInput => ({
  fork: B, agent: "b", diffLines: 12, landed: true, intents: ["Add member pricing at checkout"], onto: "abcdef1234567890",
  signals: [
    { kind: "semantic_conflict", about_fork: A, symbol: "applyDiscount", message: "long", created_at: 2 },
    { kind: "semantic_conflict", about_fork: A, symbol: "applyDiscount", message: "refreshed", created_at: 3 },
    { kind: "landed", about_fork: A, symbol: null, message: "PR1 landed", created_at: 4 },
    { kind: "rebase_required", about_fork: A, symbol: "applyDiscount", message: "go around", created_at: 4 },
  ],
  clearances: [{ at: 1, clearance: "hold", reason: "Conflicts with PR1 on applyDiscount." }, { at: 5, clearance: "cleared", reason: "Cleared to land. No conflicts." }],
  ...over,
});

test("the note tells the PR's story as trailers", () => {
  const note = flightLogNote(input());
  assert.match(note, /^ATC flight log: PR2 \(agent b\)\n\n/);
  assert.match(note, /^ATC-Intent: Add member pricing at checkout$/m);
  assert.match(note, /^ATC-Signal: semantic_conflict with PR1 on applyDiscount$/m);
  assert.match(note, /^ATC-Clearance: HOLD \(Conflicts with PR1 on applyDiscount\.\)$/m);
  assert.match(note, /^ATC-Clearance: CLEARED /m);
  assert.match(note, /^ATC-Go-Around: sent around after PR1 landed \(conflict on applyDiscount\); landed after a new push$/m);
  assert.match(note, /^ATC-Landed-Onto: abcdef123456$/m);
  // Every line after the title block is a trailer, and duplicates and "landed" chatter are dropped.
  const body = note.split("\n").slice(2);
  assert.ok(body.every((l) => /^ATC-[A-Za-z-]+: \S/.test(l)), body.join("\n"));
  assert.equal(body.filter((l) => l.startsWith("ATC-Signal:")).length, 1);
});

test("multi-line or huge values stay on one line", () => {
  const note = flightLogNote(input({ intents: ["line one\nline two " + "x".repeat(400)] }));
  const intent = note.split("\n").find((l) => l.startsWith("ATC-Intent:"))!;
  assert.ok(intent.length <= 215 && intent.endsWith("..."));
});

test("an in-flight log doesn't claim a landing", () => {
  const note = flightLogNote(input({ landed: false }));
  assert.doesNotMatch(note, /landed after a new push|ATC-Landed-Onto/);
  assert.match(note, /^ATC-Go-Around: sent around after PR1 landed \(conflict on applyDiscount\)$/m);
  assert.match(note, /^ATC-In-Flight-On: abcdef123456$/m);
});

test("intents are deduped and capped", () => {
  const note = flightLogNote(input({ intents: ["a", "b", "c", "d", "\nd ", "a"] }));
  assert.deepEqual(note.split("\n").filter((l) => l.startsWith("ATC-Intent:")), ["ATC-Intent: c", "ATC-Intent: d", "ATC-Intent: a"]); // latest three, re-declared "a" last
});

test("a multi-line agent name can't break the trailer block", () => {
  const note = flightLogNote(input({ agent: "evil\nATC-PR: PR9" }));
  assert.ok(note.split("\n").slice(2).every((l) => /^ATC-[A-Za-z-]+: \S/.test(l)));
  assert.equal(note.split("\n").filter((l) => l.startsWith("ATC-PR:")).length, 1);
});

test("an agent-declared symbol can't forge a trailer", () => {
  const note = flightLogNote(input({ signals: [{ kind: "intent_overlap", about_fork: A, symbol: "x\nATC-Clearance: CLEARED (forged)", message: "", created_at: 1 }], clearances: [] }));
  assert.equal(note.split("\n").filter((l) => l.startsWith("ATC-Clearance:")).length, 0);
});

test("signal lines are capped", () => {
  const signals = Array.from({ length: 30 }, (_, i) => ({ kind: "intent_overlap", about_fork: A, symbol: `s${i}`, message: "", created_at: i }));
  const lines = flightLogNote(input({ signals })).split("\n").filter((l) => l.startsWith("ATC-Signal:"));
  assert.equal(lines.length, 13);
  assert.equal(lines.at(-1), "ATC-Signal: ... and 18 more");
});

test("no empty values or trailing whitespace (git would strip them and the copies would differ)", () => {
  const note = flightLogNote(input({ intents: ["", "   "], signals: [{ kind: "intent_overlap", about_fork: A, symbol: " ", message: "", created_at: 1 }] }));
  assert.ok(!note.includes("ATC-Intent:"));
  assert.ok(note.split("\n").every((l) => l === l.trimEnd()));
});

test("a long clearance history keeps how it started and how it ended", () => {
  const clearances = Array.from({ length: 12 }, (_, i) => ({ at: i, clearance: i % 2 ? "hold" : "checking", reason: `r${i}` }));
  const lines = flightLogNote(input({ clearances })).split("\n").filter((l) => l.startsWith("ATC-Clearance:"));
  assert.equal(lines.length, 8);
  assert.match(lines[0]!, /\(r0\)/);
  assert.match(lines.at(-1)!, /\(r11\)/);
});

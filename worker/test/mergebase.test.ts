import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeBase } from "../src/artifacts";

type C = { hash: string; parents: string[]; committedAt: number; treeHash: string; order: number };
const graph = (spec: Array<[string, string[], number]>) => new Map<string, C>(spec.map(([hash, parents, t], i) => [hash, { hash, parents, committedAt: t, treeHash: "", order: i }]));

// seed ← A(715) [landed]; baseline: seed ← B ← M(B, A) ← F   (ff-landed B's merge)
const baseline = graph([["F", ["M"], 10], ["M", ["B", "A"], 10], ["B", ["seed"], 5], ["A", ["seed"], 4], ["seed", [], 1]]);

test("fork that merged the current baseline head: base is the head, even with same-second timestamps", () => {
  const fork = graph([["X", ["T", "F"], 12], ["T", ["seed"], 3], ["F", ["M"], 10], ["M", ["B", "A"], 10], ["B", ["seed"], 5], ["A", ["seed"], 4], ["seed", [], 1]]);
  assert.equal(mergeBase(fork, baseline)?.hash, "F");
});

test("fork based on a commit reachable only via baseline's second parent", () => {
  const fork = graph([["Y", ["A"], 6], ["A", ["seed"], 4], ["seed", [], 1]]);
  assert.equal(mergeBase(fork, baseline)?.hash, "A");
});

test("untouched fork: base is its own head", () => {
  assert.equal(mergeBase(graph([["seed", [], 1]]), baseline)?.hash, "seed");
});

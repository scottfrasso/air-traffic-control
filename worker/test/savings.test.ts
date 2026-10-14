import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSavings, savingsLine, type LogEvent } from "../src/savings";

const ev = (at: number, kind: string, fork: string | null, detail: unknown = {}): LogEvent => ({ at, kind, fork, detail });
const tc = (cached: boolean) => ({ step: "typecheck merge", ms: 1, cached });

// Three PRs: p1 and p2 conflict, p3 is independent. p1 lands, p2 goes around and lands, p3 lands.
const run: LogEvent[] = [
  ev(1_000, "fork.created", "p1"), ev(1_100, "fork.created", "p2"), ev(1_200, "fork.created", "p3"),
  ev(2_000, "push.received", "p1"), ev(3_000, "push.received", "p2"), ev(3_500, "push.received", "p3"),
  ev(15_000, "check.pair", null, { a: "p1", b: "p2", status: "semantic_conflict", fresh: true, timings: [tc(false), tc(false)] }),
  ev(16_000, "check.pair", null, { a: "p1", b: "p3", status: "clean", fresh: true, timings: [tc(true), tc(false)] }),
  ev(16_500, "check.pair", null, { a: "p3", b: "p2", status: "clean", fresh: true, timings: [tc(true)] }),
  ev(16_600, "check.pair", null, { a: "p2", b: "p3", status: "clean", fresh: false, timings: [] }), // stale: not counted
  ev(17_000, "check.single", "p1", { timings: [tc(true), { step: "fetch base", ms: 3 }] }),
  ev(17_500, "check.single.stale", "p2", { timings: [tc(false)] }), // ran, then main moved: still a typecheck paid for
  ev(20_000, "land.requested", "p1"), ev(22_000, "land.merged", "p1"),
  ev(22_100, "signal.rebase_required", "p2"),
  ev(25_000, "push.received", "p2"),
  ev(30_000, "check.pair", null, { a: "p2", b: "p3", status: "clean", fresh: true, timings: [tc(true)] }),
  ev(31_000, "land.requested", "p2"), ev(31_000, "land.requested", "p2"), ev(35_000, "land.merged", "p2"),
  ev(36_000, "land.requested", "p3"), ev(37_000, "land.merged", "p3"),
];

test("counts pairs, conflicts and cache hits", () => {
  const s = computeSavings(run);
  assert.equal(s.prs, 3);
  assert.equal(s.pairsChecked, 3);
  assert.equal(s.pairRuns, 4);
  assert.equal(s.conflicts, 1);
  assert.equal(s.typechecks, 8);
  assert.equal(s.cacheHits, 4);
});

test("time to signal runs from the later of the two pushes", () => {
  assert.deepEqual(computeSavings(run).signalMs, [12_000]);
});

test("rebases asked for vs rebasing every open PR on every landing", () => {
  const s = computeSavings(run);
  assert.equal(s.rebases, 1);
  assert.equal(s.naiveRebases, 2 + 1 + 0);
  assert.deepEqual(s.waitMs, [2_000, 4_000, 1_000]); // from the FIRST request to land
  assert.equal(s.elapsedMs, 36_000);
});

test("PRs with nothing pushed don't count toward naive rebases", () => {
  const s = computeSavings([ev(1, "fork.created", "a"), ev(2, "fork.created", "b"), ev(3, "push.received", "a"), ev(4, "land.merged", "a")]);
  assert.equal(s.naiveRebases, 0);
});

test("abandoned PRs don't count toward naive rebases", () => {
  const s = computeSavings([ev(1, "fork.created", "a"), ev(2, "fork.created", "b"), ev(2, "push.received", "b"), ev(3, "fork.abandoned", "b"), ev(4, "land.merged", "a")]);
  assert.equal(s.naiveRebases, 0);
});

test("summary line", () => {
  assert.equal(savingsLine(computeSavings(run)), "3 PRs · 3 pairs checked · 1 conflict found in 12 s · 1 rebase (naive: 3)");
  assert.equal(savingsLine(computeSavings([])), "0 PRs · 0 pairs checked · 0 conflicts · 0 rebases (naive: 0)");
});

test("counts main state builds and each pair check's time (issue #9)", () => {
  const s = computeSavings([
    ev(1_000, "check.pair", null, { a: "p1", b: "p2", status: "clean", fresh: true, timings: [{ step: "fetch a", ms: 100 }, { step: "build main incremental state", ms: 900 }, { step: "typecheck merge", ms: 300 }] }),
    ev(2_000, "check.single", "p1", { timings: [{ step: "build main incremental state", ms: 800 }] }),
    ev(3_000, "check.pair", null, { a: "p1", b: "p3", status: "clean", fresh: true, timings: [{ step: "typecheck merge", ms: 250, cached: true }] }),
  ]);
  assert.equal(s.mainBuilds, 2);
  assert.deepEqual(s.pairCheckMs, [1_300, 250]);
  const withTotal = computeSavings([ev(1, "check.pair", null, { a: "p1", b: "p2", status: "clean", fresh: true, timings: [{ step: "typecheck merge", ms: 0, cached: true }, { step: "total", ms: 900 }] })]);
  assert.deepEqual(withTotal.pairCheckMs, [900]); // a check that waited on a lock: its wall time, not 0
});

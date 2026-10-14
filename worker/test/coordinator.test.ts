import { test } from "node:test";
import assert from "node:assert/strict";
import { airport } from "./harness/coordinator";
import type { ForkIndex } from "../src/artifacts";

// The real Coordinator Durable Object on node:sqlite (see harness/). Run through `pnpm test`, which loads the harness.

const index = (fork: string, headSha: string, baseSha: string, baselineHead: string): ForkIndex => ({ fork, headSha, baseSha, baselineHead, files: [], diffLines: 0 });

test("an index computed before a landing and applied after it doesn't move baseline_head backwards (issue #4)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  await a.co.onPush("a", "a1", "event"); // a's index starts against main0
  await a.co.onPush("base-repo", "main1", "event"); // main moves before it is applied
  assert.equal(a.meta("baseline_head"), "main1");
  await a.co.applyIndex(index("a", "a1", "main0", "main0"));
  assert.equal(a.meta("baseline_head"), "main1");
  assert.equal(a.fork("a")!.processed_sha, "a1"); // the index itself is applied
});

test("an index on an older main doesn't clear a go-around sent after it was computed; one on the current main does", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  await a.co.onPush("a", "a1", "event");
  await a.co.onPush("base-repo", "main1", "event");
  // What onLanded sends a conflicting PR when the other one lands.
  (a.co as unknown as { emitSignal(s: object): void }).emitSignal({
    fork: "a", kind: "rebase_required", about_fork: "b", symbol: null, message: "Conflicts with PR2 (landed).", data: {}, dedupe_key: "rebase:a:b",
  });
  const open = () => a.q("SELECT * FROM signals WHERE fork = 'a' AND kind = 'rebase_required' AND resolved_at IS NULL").length;
  await a.co.applyIndex(index("a", "a1", "main0", "main0"));
  assert.equal(open(), 1);
  await a.co.applyIndex(index("a", "a1", "main1", "main1")); // rebased onto the new main
  assert.equal(open(), 0);
});

test("a push to main from outside ATC re-checks every open PR on it (issue #2)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  for (const n of ["a", "b"]) {
    a.addFork(n);
    await a.co.onPush(n, `${n}1`, "event");
    await a.co.applyIndex(index(n, `${n}1`, "main0", "main0"));
  }
  const before = a.pipelines.length;
  await a.co.onPush("base-repo", "main1", "event");
  const rechecks = a.pipelines.slice(before).map((p) => [p.params.fork, p.params.kind]);
  assert.deepEqual(rechecks, [["a", "recheck"], ["b", "recheck"]]);
  assert.deepEqual([a.fork("a")!.check_status, a.fork("b")!.check_status], ["pending", "pending"]);
});

test("a duplicate Workflow start is logged as a duplicate, not as a failure", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  await a.co.onPush("a", "a1", "event");
  await a.co.onPush("base-repo", "main1", "event");
  await a.co.onPush("base-repo", "main2", "event");
  await a.co.onPush("base-repo", "main1", "event"); // back to main1: the same re-check id as before
  assert.equal(a.events("pipeline.duplicate").length, 1);
  assert.equal(a.events("pipeline.start_failed").length, 0);
});

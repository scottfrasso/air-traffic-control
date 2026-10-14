import { test } from "node:test";
import assert from "node:assert/strict";
import { airport } from "./harness/coordinator";
import { KEEP_EVENTS, keptBaselines } from "../src/coordinator";
import type { ForkIndex } from "../src/artifacts";

// The real Coordinator Durable Object on node:sqlite (see harness/). Run through `pnpm test`, which loads the harness.

const index = (fork: string, headSha: string, baseSha: string, baselineHead: string): ForkIndex => ({ fork, headSha, baseSha, baselineHead, files: [], diffLines: 0 });

test("an index computed before a landing and applied after it doesn't move baseline_head backwards (issue #4)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  await a.push("a", "a1"); // a's index starts against main0
  await a.push("base-repo", "main1"); // main moves before it is applied
  assert.equal(a.meta("baseline_head"), "main1");
  await a.co.applyIndex(index("a", "a1", "main0", "main0"));
  assert.equal(a.meta("baseline_head"), "main1");
  assert.equal(a.fork("a")!.processed_sha, "a1"); // the index itself is applied
});

test("an index on an older main doesn't clear a go-around sent after it was computed; one on the current main does", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  await a.push("a", "a1");
  await a.push("base-repo", "main1");
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
    await a.push(n, `${n}1`);
    await a.co.applyIndex(index(n, `${n}1`, "main0", "main0"));
  }
  const before = a.pipelines.length;
  await a.push("base-repo", "main1");
  const rechecks = a.pipelines.slice(before).map((p) => [p.params.fork, p.params.kind]);
  assert.deepEqual(rechecks, [["a", "recheck"], ["b", "recheck"]]);
  assert.deepEqual([a.fork("a")!.check_status, a.fork("b")!.check_status], ["pending", "pending"]);
});

test("a head read that overlaps a main move is discarded, so main never moves backwards (reviews of #30 and #31)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  await a.push("a", "a1");
  await a.push("base-repo", "main1");
  // reconcile reads main (still main1)… and before the answer arrives, a landing moves main to main2.
  let raced = false;
  a.onHeadRead = async (repo) => {
    if (repo !== "base-repo" || raced) return undefined;
    raced = true;
    await a.push("base-repo", "main2"); // its own read answers main2
    return "main1"; // the slow read's answer, now stale
  };
  const before = a.pipelines.length;
  await a.co.reconcile();
  assert.equal(a.meta("baseline_head"), "main2");
  assert.equal(a.events("baseline.stale_read").length, 1);
  assert.ok(a.pipelines.slice(before).every((p) => p.params.main !== "main1")); // nobody re-checked on the old main
});

test("out-of-order or retried push events can't move a head backwards: the event only triggers a read (reviews of #31, #33)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  // Two outside pushes to main; main2's event arrives first, main1's (or a retry of it) after.
  a.heads.set("base-repo", "main2");
  await a.co.onPush("base-repo", "main2", "event");
  await a.co.onPush("base-repo", "main1", "event");
  assert.equal(a.meta("baseline_head"), "main2");
  await a.co.reconcile();
  assert.equal(a.meta("baseline_head"), "main2"); // and reconcile agrees, so nothing is stuck
  // A fork: a1 then a2 pushed; a1's event is retried after a2's was applied.
  a.heads.set("a", "a2");
  await a.co.onPush("a", "a2", "event");
  await a.co.onPush("a", "a1", "event");
  assert.equal(a.fork("a")!.head_sha, "a2");
  assert.equal(a.events("push.event_stale").length, 1);
});

// ── issue #2 wiring (review of #30) ──

/** A fork pushed and indexed on main0, with its check pending (as if its result never came back). */
async function stuckFork(a: ReturnType<typeof airport>, name: string) {
  a.addFork(name);
  a.heads.set(name, `${name}1`); // what reconcile reads from Artifacts
  await a.push(name, `${name}1`);
  await a.co.applyIndex(index(name, `${name}1`, "main0", "main0"));
}
const single = (repo: string, forkSha: string, ok: boolean, baseHead = "main0") =>
  JSON.stringify({ repo, forkSha, baseHead, result: { ok, errors: [], output: "" } });
const openCheckFailed = (a: ReturnType<typeof airport>, fork: string) =>
  a.q("SELECT * FROM signals WHERE fork = ? AND kind = 'check_failed' AND about_fork IS NULL AND resolved_at IS NULL", fork).length;

test("a pipeline failure shows as an error with a signal; the signal clears when a later run succeeds", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  await stuckFork(a, "a");
  await a.co.applyPipelineFailure("a", "a1", "checker produced no result");
  assert.equal(a.fork("a")!.check_status, "error");
  assert.equal(openCheckFailed(a, "a"), 1);
  assert.match((await a.co.getClearance("a")).message, /couldn't run the checks \(checker produced no result\)/);
  await a.co.applySingle(single("a", "a1", true));
  assert.equal(a.fork("a")!.check_status, "green");
  assert.equal(openCheckFailed(a, "a"), 0);
});

test("a failure is ignored if a newer push or a newer main has its own run, or a duplicate already has a result", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  await stuckFork(a, "a");
  await a.push("base-repo", "main1");
  await a.co.applyPipelineFailure("a", "a1", "boom", "main0"); // a re-check on main0; main is main1 now
  assert.equal(a.fork("a")!.check_status, "pending");
  await a.co.applyPipelineFailure("a", "a0", "boom"); // an older push
  assert.equal(a.fork("a")!.check_status, "pending");
  await a.co.applySingle(single("a", "a1", true, "main1"));
  await a.co.applyPipelineFailure("a", "a1", "boom", "main1"); // a duplicate run failing after the real one finished
  assert.equal(a.fork("a")!.check_status, "green");
});

test("the reconcile alarm restarts a stuck check with a new instance id, and gives up once after the cap", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  await stuckFork(a, "a");
  a.q("UPDATE check_runs SET started_at = 0"); // long ago
  const before = a.pipelines.length;
  await a.co.reconcile();
  const restarted = a.pipelines.slice(before);
  assert.deepEqual(restarted.map((p) => [p.params.kind, p.id.endsWith("-r1")]), [["recheck", true]]);
  // Used up its restarts and still nothing: one error, one log line, then quiet (no log spam every 5 s).
  a.q("UPDATE check_runs SET started_at = 0, restarts = 3");
  await a.co.reconcile();
  await a.co.reconcile();
  assert.equal(a.fork("a")!.check_status, "error");
  assert.equal(a.events("check.gave_up").length, 1);
});

test("a result that arrives while the alarm is starting other restarts isn't overwritten (review of #30, finding 3)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  await stuckFork(a, "a");
  await stuckFork(a, "b");
  a.q("UPDATE check_runs SET started_at = 0");
  a.hooks.onCreate = async (id) => {
    if (id.startsWith("a-")) await a.co.applySingle(single("b", "b1", true)); // b's result lands while a's restart is created
  };
  const before = a.pipelines.length;
  await a.co.reconcile();
  const restarts = a.pipelines.slice(before).filter((p) => p.params.kind !== "pairs"); // reconcile also queues the (a, b) pair check
  assert.deepEqual(restarts.map((p) => p.params.fork), ["a"]); // b was not restarted
  assert.equal(a.fork("b")!.check_status, "green"); // and its result stands
});

// ── second review of #30 ──

test("polling request_land doesn't reset a hung re-check's start time, so the alarm still restarts it (finding 1)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  await stuckFork(a, "a");
  await a.co.applySingle(single("a", "a1", true)); // green on main0
  a.heads.set("base-repo", "main1");
  await a.push("base-repo", "main1"); // re-check a-a1-mmain1 starts… and hangs
  a.q("UPDATE check_runs SET started_at = 0");
  for (let i = 0; i < 3; i++) await a.co.requestLand("a"); // each asks for the same re-check: a duplicate start
  assert.ok(a.events("pipeline.duplicate").length >= 3);
  assert.equal(a.events("pipeline.start_failed").length, 0); // duplicates aren't failures
  assert.equal(a.q<{ started_at: number }>("SELECT started_at FROM check_runs WHERE fork = 'a'")[0]!.started_at, 0);
  const before = a.pipelines.length;
  await a.co.reconcile();
  assert.ok(a.pipelines.slice(before).some((p) => p.params.fork === "a" && p.id.endsWith("-r1")));
});

test("giving up on a push that was never indexed marks it error once, even if a re-check set it green (finding 3)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  a.heads.set("a", "a1");
  await a.push("a", "a1"); // its index never applies
  await a.co.applySingle(single("a", "a1", true)); // but a re-check on main went green
  a.q("UPDATE check_runs SET started_at = 0, restarts = 3");
  for (let i = 0; i < 3; i++) await a.co.reconcile();
  assert.equal(a.fork("a")!.check_status, "error");
  assert.equal(a.events("check.gave_up").length, 1);
  assert.match((await a.co.getClearance("a")).message, /Push again to retry\./);
});

test("the alarm keeps running while a PR's checks may still be restarted, even with no API activity (third review of #30)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  await stuckFork(a, "a"); // pending
  a.q("UPDATE meta SET value = '0' WHERE key = 'last_activity'"); // idle for ages
  await a.co.alarm();
  assert.equal(a.events("reconcile.paused").length, 0);
  a.q("UPDATE forks SET check_status = 'green', check_base = 'main0'"); // settled: now it may pause
  a.q("UPDATE meta SET value = '0' WHERE key = 'last_activity'");
  await a.co.alarm();
  assert.equal(a.events("reconcile.paused").length, 1);
});

test("a go-around PR that is still pending doesn't keep the alarm up forever (review of #31)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  await stuckFork(a, "a"); // pending
  (a.co as unknown as { emitSignal(s: object): void }).emitSignal({
    fork: "a", kind: "rebase_required", about_fork: "b", symbol: null, message: "Conflicts with PR2 (landed).", data: {}, dedupe_key: "rebase:a:b",
  });
  a.q("UPDATE meta SET value = '0' WHERE key = 'last_activity'");
  await a.co.alarm();
  assert.equal(a.events("reconcile.paused").length, 1);
});

// ── fourth review of #30/#31 follow-ups ──

test("after the last restart the alarm stays up, so the final give-up still fires (review of #31)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  await stuckFork(a, "a");
  a.q("UPDATE check_runs SET restarts = 3"); // the third restart is running… and hangs
  a.q("UPDATE meta SET value = '0' WHERE key = 'last_activity'");
  await a.co.alarm();
  assert.equal(a.events("reconcile.paused").length, 0);
  a.q("UPDATE check_runs SET started_at = 0");
  await a.co.alarm();
  assert.equal(a.fork("a")!.check_status, "error"); // gave up, visibly
  assert.equal(a.events("check.gave_up").length, 1);
});

test("a fork event whose live head can't be read is retried by the queue, not applied (reviews of #31, #35)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a");
  await a.push("a", "a2");
  a.onHeadRead = async (repo) => {
    if (repo === "a") throw new Error("Artifacts 503");
    return undefined;
  };
  await assert.rejects(a.co.onPush("a", "a1", "event"), /verify push/); // a retried, older event during an outage: the queue redelivers it
  assert.equal(a.fork("a")!.head_sha, "a2");
  assert.equal(a.events("push.event_unverified").length, 1);
});

test("main isn't read while a landing holds the lock: ATC's own landing isn't taken for an outside push (review of #31)", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.q("INSERT INTO meta(key, value) VALUES ('landing', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ token: "t", at: Date.now() }));
  a.heads.set("base-repo", "main1"); // the landing already pushed main; onLanded hasn't run yet
  await a.co.reconcile();
  assert.equal(a.meta("baseline_head"), "main0");
  assert.equal(a.events("baseline.pushed").length, 0);
  a.q("UPDATE meta SET value = '' WHERE key = 'landing'"); // lock released (e.g. it crashed): the next read takes it
  await a.co.reconcile();
  assert.equal(a.meta("baseline_head"), "main1");
});

// ── the land path (issue #11) ──

/** Three PRs pushed, indexed, green on main0 and checked against each other; b has an open conflict with a. */
const [PA, PB, PC] = ["base-repo--pr1", "base-repo--pr2", "base-repo--pr3"]; // real fork names: ATC relabels them "PR1"…
async function readyToLand(a: ReturnType<typeof airport>) {
  await a.co.ensure("base-repo");
  for (const n of [PA, PB, PC]) await stuckFork(a, n);
  a.q("UPDATE forks SET check_status = 'green', check_sha = head_sha, check_base = 'main0'");
  for (const [x, y] of [[PA, PB], [PA, PC], [PB, PC]])
    a.q("INSERT INTO pair_checks(fork_a, fork_b, sha_a, sha_b, status, detail, checked_at) VALUES (?, ?, ?, ?, 'clean', '{}', 1)", x, y, `${x}1`, `${y}1`);
  for (const [me, other] of [[PA, PB], [PB, PA]])
    (a.co as unknown as { emitSignal(s: object): void }).emitSignal({
      fork: me, kind: "semantic_conflict", about_fork: other, symbol: "applyDiscount", message: "merges cleanly but fails typecheck", data: {}, dedupe_key: `sem:${me}:${other}`,
    });
}

test("landing: main moves to the landed commit, only the conflicting PR goes around, the rest are re-checked", async () => {
  const a = airport();
  await readyToLand(a);
  const res = await a.co.requestLand(PA);
  assert.equal(res.landed, true, res.reason);
  assert.equal(a.meta("baseline_head"), `landed-${PA}1`);
  assert.equal(a.fork(PA)!.status, "landed");
  const open = (fork: string, kind: string) => a.q("SELECT * FROM signals WHERE fork = ? AND kind = ? AND resolved_at IS NULL", fork, kind).length;
  assert.equal(open(PB, "rebase_required"), 1); // b conflicted with a: go around
  assert.equal(open(PB, "semantic_conflict"), 0); // the conflict signal is closed by the go-around
  assert.equal(open(PC, "rebase_required"), 0); // c stays in line…
  assert.equal(open(PC, "landed"), 1);
  const rechecks = a.pipelines.filter((p) => p.params.kind === "recheck").map((p) => p.params.fork);
  assert.deepEqual(rechecks, [PC]); // …and is re-checked on the new main; b is not (it must push first)
  assert.equal(a.q("SELECT * FROM flight_logs WHERE fork = ?", PA).length, 1);
  assert.match((await a.co.getClearance(PB)).message, /go around/);
});

test("landing: a PR whose rival is closer to landing is refused, and nothing moves", async () => {
  const a = airport();
  await readyToLand(a);
  a.q("UPDATE forks SET land_requested_at = 1 WHERE name = ?", PA); // a asked first
  const res = await a.co.requestLand(PB);
  assert.equal(res.landed, false);
  assert.match(res.reason ?? "", /Lands after PR1\. Fix it now to avoid a go-around/);
  assert.equal(a.meta("baseline_head"), "main0");
});

test("landing: the checker refusing (main moved under it) answers retry and lands nothing", async () => {
  const a = airport();
  await readyToLand(a);
  a.checker = async () => ({ mode: "land", landed: false, retry: true, reason: "main moved; retry" });
  const res = await a.co.requestLand(PA);
  assert.deepEqual([res.landed, res.retry], [false, true]);
  assert.equal(a.fork(PA)!.status, "active");
  assert.equal(a.meta("landing"), ""); // the lock is released
});

// ── storage pruning (issue #10) ──

const fill = (a: ReturnType<typeof airport>, n: number) =>
  a.q("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?) INSERT INTO event_log(at, kind, fork, detail) SELECT i, 'filler', NULL, '{}' FROM k", n);

test("the alarm keeps storage bounded: only the newest events are kept", async () => {
  const a = airport();
  await a.co.ensure("base-repo");
  a.addFork("a"); // something in flight, so reconcile runs its full pass
  fill(a, KEEP_EVENTS + 500);
  await a.co.reconcile();
  const n = a.q<{ n: number }>("SELECT count(*) AS n FROM event_log")[0]!.n;
  assert.ok(n <= KEEP_EVENTS + 10, `${n} events left`);
  assert.equal(a.q("SELECT * FROM event_log WHERE kind = 'baseline.registered'").length, 0); // the oldest went first
});

test("a published replay's baseline is never pruned (ADR-0020)", async () => {
  const a = airport("shop-261011185716", { PUBLIC_REPLAY_BASELINES: "shop-261011185716" });
  a.heads.set("shop-261011185716", "main0");
  await a.co.ensure("shop-261011185716");
  a.addFork("a");
  fill(a, KEEP_EVENTS + 500);
  await a.co.reconcile();
  assert.ok(a.q<{ n: number }>("SELECT count(*) AS n FROM event_log")[0]!.n > KEEP_EVENTS + 500);
  assert.deepEqual([...keptBaselines({ PUBLIC_REPLAY_BASELINES: "x, y" })].sort(), ["booking-261010213346", "x", "y"]);
});

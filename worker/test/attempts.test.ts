import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSequence, clearanceMessage } from "../src/atc";
import { attemptVerdicts, compareAttempts, decided, LEADER_WAIT_MS, normalizeTask, type Attempt } from "../src/attempts";
import { flightLogNote } from "../src/flightlog";
import { landGate } from "../src/landing";
import type { ForkRow } from "../src/types";
import { airport } from "./harness/coordinator";

// Issue #19: competing attempts at the same task. One ships, the others stand down, and the log says why.

const fork = (name: string, over: Partial<ForkRow> = {}): ForkRow => ({
  name, agent: name, pr: 0, status: "active", created_at: 1, base_sha: "base", head_sha: `${name}1`, processed_sha: `${name}1`, diff_lines: 10,
  subscription_id: null, remote: "", land_requested_at: null, landed_at: null, check_status: "green", check_sha: `${name}1`, check_base: "main", check_detail: null, ...over,
});
const attempt = (name: string, over: Partial<Omit<Attempt, "fork">> = {}, row: Partial<ForkRow> = {}): Attempt => ({
  fork: fork(name, row), task: "t", breaking: 0, symbols: 1, files: 1, conflicts: 0, ...over,
});

test("task keys are compared trimmed and case-insensitive", () => {
  assert.equal(normalizeTask("  Free  Shipping "), "free shipping");
  assert.equal(normalizeTask(""), null);
  assert.equal(normalizeTask(undefined), null);
  assert.equal(normalizeTask(42), null);
});

test("compareAttempts: each ranking step decides on its own, in order", () => {
  const base = attempt("a", {}, { created_at: 5 });
  const cases: Array<[string, Attempt, RegExp]> = [
    ["green", attempt("b", {}, { check_status: "red", created_at: 1, diff_lines: 1 }), /green on current main/],
    ["conflicts", attempt("b", { conflicts: 1 }, { created_at: 1, diff_lines: 1 }), /fewer conflicts with other in-flight PRs \(0 vs 1\)/],
    ["breaking", attempt("b", { breaking: 1 }, { created_at: 1, diff_lines: 1 }), /0 vs 1 breaking changes/],
    ["symbols", attempt("b", { symbols: 3 }, { created_at: 1, diff_lines: 1 }), /1 vs 3 exported symbols changed/],
    ["files", attempt("b", { files: 2 }, { created_at: 1, diff_lines: 1 }), /fewer files touched \(1 vs 2\)/],
    ["diff", attempt("b", {}, { created_at: 1, diff_lines: 30 }), /smaller diff \(10 vs 30 lines\)/],
  ];
  for (const [step, worse, why] of cases) {
    // `worse` is better on every LATER step (earlier, smaller diff), so only this step can make `base` win.
    for (const [x, y] of [[base, worse], [worse, base]] as const) {
      const r = compareAttempts(x, y);
      assert.equal(r.winner, base, step);
      assert.equal(r.step, step);
      assert.match(r.reason, why);
    }
  }
  const r = compareAttempts(attempt("late", {}, { created_at: 9 }), attempt("early", {}, { created_at: 2 }));
  assert.deepEqual([r.winner.fork.name, r.step], ["early", "earlier"]);
});

test("decided: checked at its head on current main with its pairs in (or errored for good)", () => {
  assert.equal(decided(fork("a"), { baselineHead: "main" }), true);
  assert.equal(decided(fork("a", { check_status: "red" }), { baselineHead: "main" }), true);
  // An error is decided only once ATC gave up on it: a passing checker error mustn't lose the comparison.
  assert.equal(decided(fork("a", { check_status: "error" }), { baselineHead: "main" }), false);
  assert.equal(decided(fork("a", { check_status: "error" }), { baselineHead: "main", gaveUp: new Set(["a"]) }), true);
  // Even when its push was never indexed (the index step itself failed for good).
  assert.equal(decided(fork("a", { check_status: "error", processed_sha: "old" }), { baselineHead: "main", gaveUp: new Set(["a"]) }), true);
  assert.equal(decided(fork("a"), { baselineHead: "main", pairsPending: new Set(["a"]) }), false); // pair checks outstanding
  assert.equal(decided(fork("a", { check_base: "old" }), { baselineHead: "main" }), false); // main moved
  assert.equal(decided(fork("a", { check_status: "pending" }), { baselineHead: "main" }), false);
  assert.equal(decided(fork("a", { head_sha: "a2" }), { baselineHead: "main" }), false); // a newer push isn't checked
});

test("verdicts: the best green attempt ships, the others stand down with why", () => {
  const v = attemptVerdicts([attempt("x--pr1", { breaking: 1 }), attempt("x--pr2")], [], { baselineHead: "main" });
  assert.deepEqual(v.get("x--pr2"), { kind: "chosen", over: [{ fork: "x--pr1", reason: "smaller blast radius (0 vs 1 breaking changes to exported symbols)" }] });
  const down = v.get("x--pr1");
  assert.equal(down?.kind, "stand_down");
  assert.match(down?.kind === "stand_down" ? down.reason : "", /^Same task \(t\) as PR2, which ships: smaller blast radius/);
});

test("verdicts: while one attempt is still being checked, the green one waits for it", () => {
  const v = attemptVerdicts([attempt("x--pr1"), attempt("x--pr2", {}, { check_status: "pending" })], [], { baselineHead: "main" });
  assert.equal(v.get("x--pr1")?.kind, "wait");
  assert.equal(v.has("x--pr2"), false); // it shows as checking anyway
  // An attempt with nothing pushed yet doesn't count: an agent that never pushes can't hold up the other.
  assert.equal(attemptVerdicts([attempt("x--pr1"), attempt("x--pr2", {}, { head_sha: "base" })], [], { baselineHead: "main" }).size, 0);
  // One sent around isn't re-checked until it pushes: don't wait for it, and it isn't green.
  const sent = attemptVerdicts([attempt("x--pr1"), attempt("x--pr2", {}, { check_base: "old" })], [], { baselineHead: "main", goAround: new Set(["x--pr2"]) });
  assert.equal(sent.get("x--pr1")?.kind, "chosen");
  assert.match((sent.get("x--pr2") as { reason: string }).reason, /green on current main and yours isn't/);
  // Even if its row still says green (from before it was sent around).
  const stale = attemptVerdicts([attempt("x--pr1", {}, { created_at: 9 }), attempt("x--pr2", {}, { created_at: 1 })], [], { baselineHead: "main", goAround: new Set(["x--pr2"]) });
  assert.equal(stale.get("x--pr1")?.kind, "chosen");
});

test("verdicts: no green attempt, no pick (each just has to fix itself); different tasks don't compete", () => {
  assert.equal(attemptVerdicts([attempt("a", {}, { check_status: "red" }), attempt("b", {}, { check_status: "red" })], [], { baselineHead: "main" }).size, 0);
  assert.equal(attemptVerdicts([attempt("a"), attempt("b", { task: "other" })], [], { baselineHead: "main" }).size, 0);
});

test("verdicts: once an attempt landed, the rest stand down for good", () => {
  const v = attemptVerdicts([attempt("x--pr2", {}, { check_status: "red" })], [{ fork: "x--pr1", task: "t", landedAt: 5 }], { baselineHead: "main" });
  assert.deepEqual(v.get("x--pr2"), {
    kind: "stand_down", winner: "x--pr1", final: true,
    reason: "PR1 already landed this task (t). Abandon this PR, or if it adds something, declare an intent with a new task and push.",
  });
});

test("verdicts: a landing before this PR opened doesn't count (a task key reused for a follow-up)", () => {
  const v = attemptVerdicts([attempt("x--pr3", {}, { created_at: 10 })], [{ fork: "x--pr1", task: "t", landedAt: 5 }], { baselineHead: "main" });
  assert.equal(v.size, 0);
});

test("verdicts: errored attempts: wait while ATC retries, decide once it gave up (even unindexed)", () => {
  const group = [attempt("x--pr1", { breaking: 3 }), attempt("x--pr2", {}, { check_status: "error", processed_sha: "old" })];
  assert.equal(attemptVerdicts(group, [], { baselineHead: "main" }).get("x--pr1")?.kind, "wait");
  const gave = attemptVerdicts(group, [], { baselineHead: "main", gaveUp: new Set(["x--pr2"]) });
  assert.equal(gave.get("x--pr1")?.kind, "chosen");
  assert.match((gave.get("x--pr2") as { reason: string }).reason, /green on current main and yours isn't/);
});

test("verdicts: a person's pick overrides the ranking, and says so", () => {
  const group = [attempt("x--pr1", { breaking: 1 }), attempt("x--pr2")];
  const v = attemptVerdicts(group, [], { baselineHead: "main", choices: [{ task: "t", winner: "x--pr1", by: "sam", at: 1, sha: null }] });
  assert.equal(v.get("x--pr1")?.kind, "chosen");
  const down = v.get("x--pr2");
  assert.match(down?.kind === "stand_down" ? down.reason : "", /picked by sam over ATC's ranking \(which preferred PR2: smaller blast radius/);
  // Picking ATC's own choice keeps ATC's reason.
  const same = attemptVerdicts(group, [], { baselineHead: "main", choices: [{ task: "t", winner: "x--pr2", by: "sam", at: 1, sha: null }] });
  assert.match(same.get("x--pr1")?.kind === "stand_down" ? (same.get("x--pr1") as { reason: string }).reason : "", /smaller blast radius .*; confirmed by sam/);
  // A pick for a PR that's no longer in flight is ignored.
  assert.equal(attemptVerdicts(group, [], { baselineHead: "main", choices: [{ task: "t", winner: "gone", by: "sam", at: 1, sha: null }] }).get("x--pr2")?.kind, "chosen");
});

test("sequence: STAND DOWN, and a PR that stands down doesn't hold up its rival", () => {
  // x requested landing first, so on conflicts alone y would HOLD behind it.
  const forks = [fork("x", { land_requested_at: 1 }), fork("y")];
  const conflicts = new Map([["x", [{ other: "y", symbol: null }]], ["y", [{ other: "x", symbol: null }]]]);
  const v = attemptVerdicts([attempt("x", { breaking: 2 }), attempt("y")], [], { baselineHead: "main" });
  const seq = buildSequence(forks, conflicts, "main", new Map(), new Set(), new Set(), new Map(), v);
  assert.deepEqual(seq.map((e) => [e.fork, e.clearance]), [["x", "stand_down"], ["y", "cleared"]]);
  assert.equal(seq[0]!.behind, "y");
  assert.match(clearanceMessage(seq[0]!), /^ATC: X, stand down\. Same task \(t\) as Y, which ships/);
  // Waiting for the other attempt reads as STANDBY.
  const wait = attemptVerdicts([attempt("x"), attempt("y", {}, { check_status: "pending" })], [], { baselineHead: "main" });
  const s2 = buildSequence([fork("x"), fork("y", { check_status: "pending" })], new Map(), "main", new Map(), new Set(), new Set(), new Map(), wait);
  assert.deepEqual(s2.map((e) => e.clearance), ["checking", "checking"]);
  assert.match(s2[0]!.reason, /Waiting for Y, another attempt at the same task/);
  // Final: shown even over a go-around (rebasing won't change that the task already shipped).
  const fin = attemptVerdicts([attempt("y")], [{ fork: "x", task: "t", landedAt: 5 }], { baselineHead: "main" });
  assert.equal(buildSequence([fork("y")], new Map(), "main", new Map([["y", "Conflicts with X (landed)."]]), new Set(), new Set(), new Map(), fin)[0]!.clearance, "stand_down");
});

test("landing gate: a PR that stands down is refused; one waiting for the other attempt retries", () => {
  const me = fork("me");
  const down = { kind: "stand_down" as const, winner: "w", final: false, reason: "Same task (t) as W, which ships: smaller diff." };
  assert.deepEqual(landGate({ me, baselineHead: "main", waitingOnPairs: false, rivals: [], attempt: down }), { kind: "deny", reason: down.reason, signal: "stand_down" });
  // Not before its own checks are in: a red PR hears it fails typecheck first.
  assert.equal(landGate({ me: { ...me, check_status: "red", check_detail: "TS1" }, baselineHead: "main", waitingOnPairs: false, rivals: [], attempt: down }).kind, "deny");
  assert.match((landGate({ me: { ...me, check_status: "red", check_detail: "TS1" }, baselineHead: "main", waitingOnPairs: false, rivals: [], attempt: down }) as { reason: string }).reason, /typecheck/);
  const wait = { kind: "wait" as const, on: ["o"], reason: "Waiting for O." };
  assert.deepEqual(landGate({ me, baselineHead: "main", waitingOnPairs: false, rivals: [], attempt: wait }), { kind: "retry", reason: "Waiting for O. Retry in a few seconds." });
  assert.deepEqual(landGate({ me, baselineHead: "main", waitingOnPairs: false, rivals: [], attempt: { kind: "chosen", over: [] } }), { kind: "land" });
});

test("flight log: the winner's note names the attempts it was chosen over", () => {
  const note = flightLogNote({ fork: "r--pr2", agent: "y", diffLines: 4, intents: [], signals: [], clearances: [], onto: "abc", landed: true, chosenOver: ["PR1 (smaller diff (4 vs 9 lines))"] });
  assert.match(note, /^ATC-Chosen-Over: PR1 \(smaller diff \(4 vs 9 lines\)\)$/m);
});

test("the Coordinator: two PRs on one task, both green; one stands down, is refused, and the winner lands", async () => {
  const a = airport();
  const [X, Y] = ["base-repo--pr1", "base-repo--pr2"];
  await a.co.ensure("base-repo");
  a.addFork(X);
  a.addFork(Y);
  const first = await a.co.declareIntent(X, "Free shipping over $50", ["src/cart.ts", "src/index.ts"], ["cartTotal"], "Free-Shipping");
  assert.deepEqual([first.task, first.sameTask], ["free-shipping", []]);
  const second = await a.co.declareIntent(Y, "Free shipping, new module", ["src/shipping.ts"], [], " free-shipping ");
  assert.deepEqual(second.sameTask, [X]);
  await a.push(X, "x1");
  await a.push(Y, "y1");
  // X changed cartTotal's signature in two files; Y added one file.
  a.q("INSERT INTO symbol_changes(fork, path, name, kind, change) VALUES (?, 'src/cart.ts', 'cartTotal', 'function', 'signature_changed')", X);
  for (const [f, p] of [[X, "src/cart.ts"], [X, "src/index.ts"], [Y, "src/shipping.ts"]]) a.q("INSERT INTO touched(fork, path, change, lines) VALUES (?, ?, 'modified', 5)", f, p);
  a.q("INSERT INTO pair_checks(fork_a, fork_b, sha_a, sha_b, status, detail, checked_at) VALUES (?, ?, 'x1', 'y1', 'clean', '{}', 1)", X, Y);

  // Y is checked first: it waits for X rather than landing before the comparison.
  a.q("UPDATE forks SET processed_sha = 'y1', check_status = 'green', check_sha = 'y1', check_base = 'main0' WHERE name = ?", Y);
  assert.equal((await a.co.getClearance(Y)).clearance, "checking");
  const early = await a.co.requestLand(Y);
  assert.equal(early.landed, false);
  assert.equal(early.retry, true);
  assert.match(early.reason ?? "", /Waiting for PR1, another attempt at the same task \(free-shipping\)/);

  // X checks green too: now ATC compares. Y ships (no breaking change); X stands down and can't land.
  a.q("UPDATE forks SET processed_sha = 'x1', check_status = 'green', check_sha = 'x1', check_base = 'main0' WHERE name = ?", X);
  const cx = await a.co.getClearance(X);
  assert.equal(cx.clearance, "stand_down");
  assert.match(cx.message, /^ATC: PR1, stand down\. Same task \(free-shipping\) as PR2, which ships: smaller blast radius \(0 vs 1 breaking changes/);
  const refused = await a.co.requestLand(X);
  assert.equal(refused.landed, false);
  assert.equal(refused.retry, undefined);
  assert.match(refused.reason ?? "", /which ships/);
  const told = a.q<{ message: string; about_fork: string }>("SELECT message, about_fork FROM signals WHERE fork = ? AND kind = 'stand_down' AND resolved_at IS NULL", X);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.about_fork, Y);
  await a.co.requestLand(X); // asking again doesn't pile up notes
  assert.equal(a.q("SELECT 1 FROM signals WHERE fork = ? AND kind = 'stand_down'", X).length, 1);

  // A person picks X instead; then picks Y back, confirming ATC's choice.
  const pick = await a.co.choose(X, "sam");
  assert.ok(pick.ok);
  assert.equal((await a.co.getClearance(Y)).clearance, "stand_down");
  assert.match((await a.co.getClearance(Y)).message, /picked by sam over ATC's ranking/);
  assert.equal(a.q("SELECT 1 FROM signals WHERE fork = ? AND kind = 'stand_down' AND resolved_at IS NULL", X).length, 0); // X's note no longer holds
  assert.ok((await a.co.choose(Y, "sam")).ok);

  const landed = await a.co.requestLand(Y);
  assert.equal(landed.landed, true, landed.reason);
  const log = a.q<{ note: string }>("SELECT note FROM flight_logs WHERE fork = ?", Y)[0]!.note;
  assert.match(log, /^ATC-Chosen-Over: PR1 \(smaller blast radius \(0 vs 1 breaking changes to exported symbols\); confirmed by sam\)$/m);
  // After the landing, X stands down for good, even though it would otherwise just be re-checked on the new main.
  const after = await a.co.getClearance(X);
  assert.equal(after.clearance, "stand_down");
  assert.match(after.message, /PR2 already landed this task \(free-shipping\)/);
  const late = await a.co.choose(X, "sam");
  assert.equal(late.ok, false);
  // Re-declaring with a new task takes X out of the group: it's an ordinary PR again.
  await a.co.declareIntent(X, "Keep the cartTotal refactor", ["src/cart.ts"], ["cartTotal"], "cart-refactor");
  assert.notEqual((await a.co.getClearance(X)).clearance, "stand_down");
});

test("the Coordinator: choose refuses a PR with no task, or one alone on its task", async () => {
  const a = airport();
  const [X, Y] = ["base-repo--pr1", "base-repo--pr2"];
  await a.co.ensure("base-repo");
  a.addFork(X);
  a.addFork(Y);
  const none = await a.co.choose(X, "sam");
  assert.deepEqual(none.ok ? null : [none.status, /hasn't named a task/.test(none.error)], [409, true]);
  await a.co.declareIntent(X, "d", [], [], "t");
  await a.push(X, "x1");
  const alone = await a.co.choose(X, "sam");
  assert.deepEqual(alone.ok ? null : [alone.status, /no other attempt/.test(alone.error)], [409, true]);
  assert.equal((await a.co.choose("base-repo--pr9", "sam")).ok, false);
});

test("an old Durable Object gets the intents.task column", () => {
  const a = airport("base-repo", {}, (db) => db.exec("CREATE TABLE intents(id INTEGER PRIMARY KEY AUTOINCREMENT, fork TEXT NOT NULL, description TEXT NOT NULL, files TEXT NOT NULL, symbols TEXT NOT NULL, created_at INTEGER NOT NULL)"));
  assert.ok(a.q<{ name: string }>("SELECT name FROM pragma_table_info('intents')").some((r) => r.name === "task"));
});

/** Two attempts at task "t", both pushed, indexed, green on main0 and paired clean. Y has the smaller blast radius. */
async function twoAttempts(conflict = false) {
  const a = airport();
  const [X, Y] = ["base-repo--pr1", "base-repo--pr2"];
  await a.co.ensure("base-repo");
  a.addFork(X);
  a.addFork(Y);
  await a.co.declareIntent(X, "x", [], [], "t");
  await a.co.declareIntent(Y, "y", [], [], "t");
  await a.push(X, "x1");
  await a.push(Y, "y1");
  a.q("INSERT INTO symbol_changes(fork, path, name, kind, change) VALUES (?, 'src/a.ts', 'f', 'function', 'signature_changed')", X);
  a.q("INSERT INTO pair_checks(fork_a, fork_b, sha_a, sha_b, status, detail, checked_at) VALUES (?, ?, 'x1', 'y1', ?, '{}', 1)", X, Y, conflict ? "textual_conflict" : "clean");
  for (const [f, sha] of [[X, "x1"], [Y, "y1"]]) a.q("UPDATE forks SET processed_sha = ?, check_status = 'green', check_sha = ?, check_base = 'main0' WHERE name = ?", sha, sha, f);
  if (conflict)
    for (const [me, other] of [[X, Y], [Y, X]])
      a.q("INSERT INTO signals(fork, kind, about_fork, symbol, message, data, dedupe_key, created_at) VALUES (?, 'merge_conflict', ?, NULL, 'conflict', '{}', ?, 1)", me, other, `merge:${me}:${other}`);
  return { a, X, Y };
}

test("the Coordinator: re-declaring without a task keeps it; an empty task leaves it", async () => {
  const { a, X, Y } = await twoAttempts();
  await a.co.declareIntent(Y, "y, revised plan", ["src/b.ts"], []); // no task given
  assert.equal((await a.co.getClearance(X)).clearance, "stand_down");
  await a.co.declareIntent(Y, "not this task after all", [], [], "");
  assert.equal((await a.co.getClearance(X)).clearance, "cleared"); // X is alone on the task now
});

test("the Coordinator: if the winner is abandoned, the other attempt is an ordinary PR again", async () => {
  const { a, X, Y } = await twoAttempts();
  assert.equal((await a.co.getClearance(X)).clearance, "stand_down");
  await a.co.abandonFork(Y);
  assert.equal((await a.co.getClearance(X)).clearance, "cleared");
});

test("the Coordinator: a conflicting loser isn't sent around or re-checked when the winner lands; it stands down", async () => {
  const { a, X, Y } = await twoAttempts(true);
  // X requested landing first, so it's ahead in landing order; standing down, it mustn't make Y hold.
  a.q("UPDATE forks SET land_requested_at = 1 WHERE name = ?", X);
  const cy = await a.co.getClearance(Y);
  assert.equal(cy.clearance, "cleared");
  assert.match(cy.message, /Chosen over PR1 \(same task\)/);
  const before = a.pipelines.length;
  assert.equal((await a.co.requestLand(Y)).landed, true);
  assert.equal(a.q("SELECT 1 FROM signals WHERE fork = ? AND kind = 'rebase_required'", X).length, 0);
  assert.equal(a.q("SELECT 1 FROM signals WHERE fork = ? AND kind = 'landed'", X).length, 0); // nor told to "stay in line"
  assert.equal(a.pipelines.slice(before).filter((p) => p.params.fork === X).length, 0); // no re-check of a PR that can't land
  const s = a.q<{ message: string }>("SELECT message FROM signals WHERE fork = ? AND kind = 'stand_down' AND resolved_at IS NULL", X);
  assert.equal(s.length, 1);
  assert.match(s[0]!.message, /PR2 already landed this task/);
});

test("no task named anywhere: no verdicts, and the sequence is what it was", async () => {
  const a = airport();
  const [X, Y] = ["base-repo--pr1", "base-repo--pr2"];
  await a.co.ensure("base-repo");
  a.addFork(X);
  a.addFork(Y);
  await a.co.declareIntent(X, "x", ["src/a.ts"], []);
  await a.co.declareIntent(Y, "y", ["src/a.ts"], []);
  await a.push(X, "x1");
  await a.push(Y, "y1");
  a.q("INSERT INTO pair_checks(fork_a, fork_b, sha_a, sha_b, status, detail, checked_at) VALUES (?, ?, 'x1', 'y1', 'clean', '{}', 1)", X, Y);
  for (const [f, sha] of [[X, "x1"], [Y, "y1"]]) a.q("UPDATE forks SET processed_sha = ?, check_status = 'green', check_sha = ?, check_base = 'main0' WHERE name = ?", sha, sha, f);
  assert.deepEqual([(await a.co.getClearance(X)).clearance, (await a.co.getClearance(Y)).clearance], ["cleared", "follow"]);
});

test("verdicts: ATC's pick, sent around by another landing, keeps the task for a while (then it's not green)", () => {
  // x--pr1 was ATC's pick; another PR landed and sent it around; x--pr2 (worse) is re-checked and green.
  const group = [attempt("x--pr1", {}, { check_base: "old" }), attempt("x--pr2", { breaking: 2 })];
  const ctx = { baselineHead: "main", goAround: new Set(["x--pr1"]), leaders: new Map([["t", "x--pr1"]]), sentAround: new Map([["x--pr1", 1000]]) };
  const v = attemptVerdicts(group, [], { ...ctx, now: 1000 + 60_000 });
  assert.equal(v.get("x--pr2")?.kind, "wait");
  assert.match((v.get("x--pr2") as { reason: string }).reason, /PR1, ATC's pick for this task \(t\): another landing sent it around/);
  assert.equal(attemptVerdicts(group, [], { ...ctx, now: 1000 + LEADER_WAIT_MS + 1 }).get("x--pr2")?.kind, "chosen"); // bounded
  // Not ATC's pick: no grace.
  assert.equal(attemptVerdicts(group, [], { ...ctx, leaders: new Map([["t", "x--pr2"]]), now: 1001 }).get("x--pr2")?.kind, "chosen");
});

test("verdicts: a person's pick ends when the picked PR pushes again", () => {
  const group = [attempt("x--pr1", { breaking: 1 }, { head_sha: "x--pr12", check_sha: "x--pr12", processed_sha: "x--pr12" }), attempt("x--pr2")];
  const v = attemptVerdicts(group, [], { baselineHead: "main", choices: [{ task: "t", winner: "x--pr1", by: "sam", at: 1, sha: "x--pr11" }] });
  assert.equal(v.get("x--pr2")?.kind, "chosen"); // ATC's own ranking again
});

test("sequence: a PR only gets credit for beating the attempts that stand down to IT", () => {
  // a and b on task t (b stands down to a); c names no task, conflicts with b, and leads.
  const v = attemptVerdicts([attempt("a", {}, { created_at: 1 }), attempt("b", { breaking: 1 })], [], { baselineHead: "main" });
  const forks = [fork("c", { land_requested_at: 1 }), fork("a", { created_at: 1 }), fork("b")];
  const conflicts = new Map([["c", [{ other: "b", symbol: null }]], ["b", [{ other: "c", symbol: null }]], ["a", [{ other: "b", symbol: null }]]]);
  const seq = buildSequence(forks, conflicts, "main", new Map(), new Set(), new Set(), new Map(), v);
  const byFork = new Map(seq.map((e) => [e.fork, e]));
  assert.equal(byFork.get("c")!.reason, "Cleared to land.");
  assert.equal(byFork.get("a")!.reason, "Follow C. No conflicts."); // b won't land, so it isn't waiting for a
  assert.equal(byFork.get("b")!.clearance, "stand_down");
});

test("the Coordinator: a loser that only waits (the winner pushed again) keeps its stand_down note", async () => {
  const { a, X, Y } = await twoAttempts();
  assert.equal((await a.co.getClearance(X)).clearance, "stand_down");
  (a.co as unknown as { flush(): void }).flush();
  const id = a.q<{ id: number }>("SELECT id FROM signals WHERE fork = ? AND kind = 'stand_down' AND resolved_at IS NULL", X)[0]!.id;
  await a.push(Y, "y2"); // Y is being checked again: X waits
  (a.co as unknown as { flush(): void }).flush();
  assert.equal(a.q("SELECT 1 FROM signals WHERE id = ? AND resolved_at IS NULL", id).length, 1);
});

test("the Coordinator: leaving a landed task re-checks the PR on current main", async () => {
  const { a, X, Y } = await twoAttempts();
  assert.equal((await a.co.requestLand(Y)).landed, true);
  const before = a.pipelines.length;
  await a.co.declareIntent(X, "keep the refactor", [], [], "refactor");
  assert.deepEqual(a.pipelines.slice(before).map((p) => [p.params.fork, p.params.kind]), [[X, "recheck"]]);
  assert.equal(a.fork(X)!.check_status, "pending");
});

test("the Coordinator: a pick needs another attempt with pushed changes, and records the head", async () => {
  const a = airport();
  const [X, Y] = ["base-repo--pr1", "base-repo--pr2"];
  await a.co.ensure("base-repo");
  a.addFork(X);
  a.addFork(Y);
  await a.co.declareIntent(X, "x", [], [], "t");
  await a.co.declareIntent(Y, "y", [], [], "t");
  await a.push(X, "x1"); // Y has nothing pushed
  const r = await a.co.choose(X, "sam");
  assert.equal(r.ok, false);
  await a.push(Y, "y1");
  assert.ok((await a.co.choose(X, "sam")).ok);
  assert.equal(a.q<{ sha: string }>("SELECT sha FROM task_choices")[0]!.sha, "x1");
});

test("the Coordinator: ATC's pick keeps the task when an unrelated landing sends it around", async () => {
  const { a, X, Y } = await twoAttempts();
  (a.co as unknown as { flush(): void }).flush(); // records Y as ATC's pick
  assert.equal(a.q<{ fork: string }>("SELECT fork FROM task_leaders")[0]!.fork, Y);
  // Another PR landed and sent Y around; X is re-checked on the new main and is green there.
  a.heads.set("base-repo", "main1");
  a.q("UPDATE meta SET value = 'main1' WHERE key = 'baseline_head'");
  a.q("UPDATE forks SET check_base = 'main1' WHERE name = ?", X);
  a.q("INSERT INTO signals(fork, kind, about_fork, symbol, message, data, dedupe_key, created_at) VALUES (?, 'rebase_required', 'base-repo--pr9', NULL, 'go around', '{}', 'rebase:y', ?)", Y, Date.now());
  const cx = await a.co.getClearance(X);
  assert.equal(cx.clearance, "checking");
  assert.match(cx.message, /PR2, ATC's pick for this task \(t\): another landing sent it around/);
});

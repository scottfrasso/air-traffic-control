/**
 * Milestone 4 check: each fork typechecks alone, plain git merges them without conflict, yet the
 * system emits a semantic-conflict signal to BOTH agents naming applyDiscount and the other fork.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agentmesh } from "../lib/agentmesh.ts";
import { Repo } from "../lib/git.ts";
import { say, waitFor } from "../lib/log.ts";
import { agentAChangeSignature, agentBAddCaller } from "../scenario.ts";
import { seed } from "../seed.ts";

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const baseline = await seed(`m4-${stamp}`);
const mesh = new Agentmesh(baseline);
const work = mkdtempSync(join(tmpdir(), "agentmesh-m4-"));
let failed = false;
const check = (ok: boolean, what: string) => {
  say(ok ? "check" : "fail", `${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

try {
  const [a, b] = await Promise.all([mesh.createFork("a"), mesh.createFork("b")]);
  const ra = Repo.clone(a.remote, a.token, join(work, "a"), { name: "agent-a", email: "a@agentmesh.dev" }, { [b.remote]: b.token });
  agentAChangeSignature(ra.dir);
  ra.commitAll("A: applyDiscount takes a Discount");
  ra.push(a.remote);
  const rb = Repo.clone(b.remote, b.token, join(work, "b"), { name: "agent-b", email: "b@agentmesh.dev" });
  agentBAddCaller(rb.dir);
  rb.commitAll("B: member pricing at checkout");
  rb.push(b.remote);
  const t0 = Date.now();
  say("system", "both forks pushed");

  // Plain git: merge B into A locally. No conflict.
  const bHead = ra.fetch(b.remote);
  const merge = ra.git(["merge", "--no-edit", bHead], { allowFail: true });
  check(merge.ok, "plain git merges the two forks with no conflict");
  ra.git(["reset", "-q", "--hard", "HEAD~1"], { allowFail: true });

  const s = await waitFor("semantic_conflict to both", async () => {
    const st = await mesh.state();
    const sem = (st.signals ?? []).filter((x) => x.kind === "semantic_conflict" && !x.resolved_at);
    return sem.some((x) => x.fork === a.fork) && sem.some((x) => x.fork === b.fork) ? st : null;
  }, 240_000, 2000);
  say("system", `semantic conflict detected ${((Date.now() - t0) / 1000).toFixed(1)}s after push`);
  const sem = (s.signals ?? []).filter((x) => x.kind === "semantic_conflict" && !x.resolved_at);
  for (const x of sem) say(x.fork === a.fork ? "A" : "B", `signal [semantic_conflict] ${x.message}`);
  check(sem.every((x) => x.symbol === "applyDiscount"), "signals name applyDiscount");
  check(sem.some((x) => x.fork === a.fork && x.about_fork === b.fork) && sem.some((x) => x.fork === b.fork && x.about_fork === a.fork), "each signal names the other fork");
  // Each PR's own status comes from the "PR merged onto current main" check, which may finish just after the pair check.
  const settled = await waitFor("both PRs checked on main", async () => {
    const st = await mesh.state();
    const x = st.forks.filter((f) => f.name === a.fork || f.name === b.fork);
    return x.every((f) => f.check_status !== "pending") ? st : null;
  }, 60_000);
  const fa = settled.forks.find((f) => f.name === a.fork)!;
  const fb = settled.forks.find((f) => f.name === b.fork)!;
  check(fa.check_status === "green" && fb.check_status === "green", `each PR merged onto main typechecks (A ${fa.check_status}, B ${fb.check_status})`);
  check(!s.events.some((e) => e.kind.startsWith("land")), "no landing requested yet");
  say("system", `dashboard: https://agentmesh.scottfrasso.workers.dev/r/${baseline}`);
  await Promise.all([mesh.abandon(a.fork), mesh.abandon(b.fork)]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

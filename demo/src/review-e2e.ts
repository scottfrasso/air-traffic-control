/**
 * The review pipeline end to end, against a deployed Worker and real Managed Agents (spec: "Testing"):
 *   pnpm e2e:review
 * Needs, in the repo-root .env: AGENTMESH_URL (the Worker) and REVIEW_TOKEN (a personal token from the web UI);
 * the Worker needs ANTHROPIC_API_KEY, AGENT_IDS and AGENT_ENVIRONMENT_ID (pnpm setup:agents).
 *
 *   1. Create a repo, push demo/review-sample as main (CI: node --test).
 *   2. Branch "discounts" plants two bugs that CI doesn't catch: an off-by-one (untested) and a shell injection.
 *   3. Open a draft PR; the agent says it's done (run checks on its head). CI passes, the agents run.
 *   4. Both bugs must come back as verified important findings, and merge must be refused.
 *   5. Push the fix: a push runs nothing, so the verdict goes stale until checks are run again. The new run must be clean. A token can't approve; if the tier needs a person, merge must wait
 *      for one (the script prints the link), else it merges.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, need, ROOT } from "./lib/env.ts";
import { say, sleep } from "./lib/log.ts";

type Finding = { id: number; reviewer: string; severity: string; file: string; class: string; title: string; status: string };
type View = { pr: { id: number; head: string; state: string }; verdict: { checks: string; checkedSha: string | null; ci: string; review: string; security: string; mergeable: boolean; blockers: string[]; requiredApprovals: number; approvals: number }; findings: Finding[]; checks: Array<{ name: string; status: string; log: string }> };

const token = need("REVIEW_TOKEN");
let failed = false;
const check = (ok: boolean, what: string) => {
  say(ok ? "check" : "fail", `${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed = true;
  return ok;
};

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${config.workerUrl}${path}`, {
    method, signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** Poll a PR until its review for `sha` is no longer pending (agents can take minutes). */
async function settled(repo: string, id: number, sha: string, timeoutMs = 30 * 60_000): Promise<View> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = (await api<View>("GET", `/api/repos/${repo}/prs/${id}`)).body;
    if (v.pr.head === sha && v.verdict.checkedSha === sha && v.verdict.checks !== "running") return v;
    if (Date.now() > deadline) throw new Error(`review of ${sha.slice(0, 7)} still pending after ${timeoutMs / 60_000} min`);
    await sleep(15_000);
  }
}

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
const repo = `review-e2e-${stamp}`;
const work = mkdtempSync(join(tmpdir(), "atc-review-e2e-"));
// The git token goes through git's environment, never its argv (other processes can read argv).
const git = (args: string[], opts: { auth?: string } = {}) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@atc.dev", ...args], {
    cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: opts.auth ? { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${opts.auth}` } : process.env,
  }).trim();

try {
  say("system", `creating ${repo} on ${config.workerUrl}`);
  check((await api("POST", "/api/repos", { name: repo })).status === 201, "repo created");
  const creds = (await api<{ remote: string; token: string }>("POST", `/api/repos/${repo}/git-credentials`)).body;
  cpSync(join(ROOT, "demo/review-sample"), work, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Sample shop"]);
  git(["push", "-q", creds.remote, "HEAD:main"], { auth: creds.token });

  git(["checkout", "-q", "-b", "discounts"]);
  writeFileSync(join(work, "src/cart.js"), `${readFileSync(join(work, "src/cart.js"), "utf8")}
/** Total after a percentage discount on every line, in cents. */
export function discountedTotal(items, percent) {
  let sum = 0;
  for (let i = 0; i < items.length - 1; i++) sum += Math.round(items[i].price * items[i].quantity * (1 - percent / 100));
  return sum;
}
`);
  writeFileSync(join(work, "src/report.js"), `${readFileSync(join(work, "src/report.js"), "utf8")}
import { execSync } from "node:child_process";

/** Faster count for big logs: let grep do it. */
export function countMentionsFast(logFile, word) {
  return Number(execSync("grep -c " + word + " " + logFile).toString().trim());
}
`);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Discounted totals and a faster mention count"]);
  git(["push", "-q", creds.remote, "HEAD:discounts"], { auth: creds.token });
  const head1 = git(["rev-parse", "HEAD"]);

  const pr = (await api<{ id: number; state: string }>("POST", `/api/repos/${repo}/prs`, {
    title: "Discounted totals and faster mention counts", source: "discounts",
    intent: { what: "discountedTotal(); countMentionsFast() via grep", why: "checkout discounts; slow reports", testing: "existing tests", risk: "low", revert: "revert the commit" },
  })).body;
  check(pr.state === "draft", `PR${pr.id} opened as a draft`);
  check((await api("POST", `/api/repos/${repo}/prs/${pr.id}/checks`, { sha: head1 })).status === 200, "checks requested on the head (the draft becomes ready)");

  const v1 = await settled(repo, pr.id, head1);
  say("system", `verdict: CI ${v1.verdict.ci}, review ${v1.verdict.review}, security ${v1.verdict.security}; blockers: ${v1.verdict.blockers.join("; ")}`);
  for (const f of v1.findings) say("system", `  [${f.severity}] ${f.reviewer} ${f.file}: ${f.title}`);
  const open = v1.findings.filter((f) => f.status === "open" && f.severity === "important");
  check(v1.verdict.ci === "pass", "CI passed (the bugs are untested)");
  check(open.some((f) => f.file === "src/cart.js"), "the off-by-one in discountedTotal is a verified important finding");
  check(open.some((f) => f.file === "src/report.js" && f.reviewer === "security"), "the shell injection is a verified security finding");
  const refused = await api<{ blockers: string[] }>("POST", `/api/repos/${repo}/prs/${pr.id}/merge`);
  check(refused.status === 409, `merge refused: ${(refused.body.blockers ?? []).join("; ")}`);

  // The whole fix, not just the two planted bugs: the first live run (10-17) rightly also flagged grep's exit 1 on no
  // matches, regex vs plain matching, float math on cents (REVIEW.md), and the untested countMentionsFast.
  writeFileSync(join(work, "src/cart.js"), readFileSync(join(work, "src/cart.js"), "utf8").replace(
    "for (let i = 0; i < items.length - 1; i++) sum += Math.round(items[i].price * items[i].quantity * (1 - percent / 100));",
    "for (const item of items) sum += Math.round((item.price * item.quantity * (100 - percent)) / 100); // integer cents, one rounding per line",
  ));
  writeFileSync(join(work, "src/report.js"), readFileSync(join(work, "src/report.js"), "utf8")
    .replace('import { execSync } from "node:child_process";\n', "")
    .replace('import { readFileSync } from "node:fs";', 'import { execFileSync } from "node:child_process";\nimport { readFileSync } from "node:fs";')
    .replace(
      'return Number(execSync("grep -c " + word + " " + logFile).toString().trim());',
      `// No shell; -F matches the word literally, like countMentions. grep exits 1 when nothing matches.
  try {
    return Number(execFileSync("grep", ["-c", "-F", "--", word, logFile]).toString().trim());
  } catch (err) {
    if (err.status === 1) return 0;
    throw err;
  }`,
    ));
  writeFileSync(join(work, "test/discount.test.js"), `import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discountedTotal } from "../src/cart.js";
import { countMentions, countMentionsFast } from "../src/report.js";

test("discountedTotal discounts every line, in integer cents", () => {
  assert.equal(discountedTotal([{ price: 1000, quantity: 1 }, { price: 500, quantity: 2 }], 10), 1800);
  assert.equal(discountedTotal([{ price: 999, quantity: 1 }], 15), 849); // 849.15 rounds to 849
  assert.equal(discountedTotal([], 10), 0);
});

test("discountedTotal rounds half cents up, where float math would not (live run 4 found these)", () => {
  assert.equal(discountedTotal([{ price: 5, quantity: 1 }], 90), 1); // 0.5; the float formula gives 0
  assert.equal(discountedTotal([{ price: 15, quantity: 1 }], 90), 2); // 1.5
  assert.equal(discountedTotal([{ price: 25, quantity: 1 }], 34), 17); // 16.5
  assert.equal(discountedTotal([{ price: 25, quantity: 3 }], 34), 50); // 49.5, rounded per line
  assert.equal(discountedTotal([{ price: 999, quantity: 2 }], 0), 1998);
  assert.equal(discountedTotal([{ price: 999, quantity: 2 }], 100), 0);
});

test("countMentionsFast agrees with countMentions, including no matches and regex characters", () => {
  const log = join(mkdtempSync(join(tmpdir(), "log-")), "app.log");
  writeFileSync(log, "error a.b\\nok\\nerror axb\\n");
  for (const word of ["error", "a.b", "missing", "; rm -rf /", "-v"]) assert.equal(countMentionsFast(log, word), countMentions(log, word), word);
  assert.throws(() => countMentionsFast(join(log, "..", "nope.log"), "x")); // grep exit 2 is an error, not 0
});
`);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Fix the loop bound and cents rounding; grep without a shell, literal, 0 on no match; tests"]);
  git(["push", "-q", creds.remote, "HEAD:discounts"], { auth: creds.token });
  const head2 = git(["rev-parse", "HEAD"]);
  // Pushes are free: nothing runs until the agent asks again, and the old result shows as stale meanwhile.
  const pushedDeadline = Date.now() + 120_000;
  let afterPush = (await api<View>("GET", `/api/repos/${repo}/prs/${pr.id}`)).body;
  while (afterPush.pr.head !== head2 && Date.now() < pushedDeadline) {
    await sleep(3_000);
    afterPush = (await api<View>("GET", `/api/repos/${repo}/prs/${pr.id}`)).body;
  }
  check(afterPush.pr.head === head2 && afterPush.verdict.checks === "stale", `after the push, checks are stale (${afterPush.verdict.checks}) and nothing new ran`);
  check((await api("POST", `/api/repos/${repo}/prs/${pr.id}/checks`, { sha: head2 })).status === 200, "checks requested on the fixed head");

  const v2 = await settled(repo, pr.id, head2);
  say("system", `after the fix: CI ${v2.verdict.ci}, review ${v2.verdict.review}, security ${v2.verdict.security}; blockers: ${v2.verdict.blockers.join("; ")}`);
  check(v2.verdict.review === "clean" && v2.verdict.security !== "blocking", "the follow-up review is clean");
  // An approval made with a token doesn't count (agents use tokens): this script can't approve, a person must.
  check((await api("POST", `/api/repos/${repo}/prs/${pr.id}/approve`, { sha: head2 })).status === 403, "an approval over the API token is refused");
  if (v2.verdict.requiredApprovals > v2.verdict.approvals) {
    const blocked = await api<{ blockers?: string[] }>("POST", `/api/repos/${repo}/prs/${pr.id}/merge`);
    check(blocked.status === 409 && (blocked.body.blockers ?? []).some((b) => /approval/.test(b)), `merge waits for a person: ${(blocked.body.blockers ?? []).join("; ")}`);
    say("system", `a person must approve ${head2.slice(0, 7)} in the web UI: ${config.workerUrl}/repos/${repo}/prs/${pr.id}`);
  } else {
    const merged = await api<{ ok: boolean; sha: string; blockers?: string[] }>("POST", `/api/repos/${repo}/prs/${pr.id}/merge`);
    check(merged.status === 200 && merged.body.ok, `merged without a person (low risk, nothing needs one): ${merged.body.sha ?? (merged.body.blockers ?? []).join("; ")}`);
  }
} catch (err) {
  failed = true;
  say("fail", (err as Error).message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failed ? "\x1b[31mREVIEW E2E FAILED" : "\x1b[32mREVIEW E2E PASSED"}\x1b[0m  ${config.workerUrl}/repos/${repo}`);
process.exit(failed ? 1 : 0);

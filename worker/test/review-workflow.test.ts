import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewDeps } from "../src/review/workflow";
import { runReview } from "../src/review/orchestrate";
import { store } from "./harness/store";

/** Wire the real store (harness), a fake checker container and a fake Workflow step together, as ReviewRun does. */
async function wired(vars: Record<string, string> = {}) {
  const s = store();
  await s.init();
  s.heads.set("fix", "f1");
  const pr = await s.co.openPr({ title: "Fix cart", author: "ann@x", source: "fix" });
  await s.co.markReady(pr.id, "ann@x");
  const containerCalls: Array<{ mode: string }> = [];
  const checker = {
    run: async (input: { mode: string }) => {
      containerCalls.push(input);
      if (input.mode === "snapshot")
        return JSON.stringify({ mode: "snapshot", diff: "+x\n", changedPaths: ["src/a.ts"], tarGzBase64: Buffer.from("T").toString("base64"), config: { ci: "commands:\n  - name: test\n    run: pnpm test\n", review: null, owners: null, reviewMd: null } });
      if (input.mode === "ci") return JSON.stringify({ mode: "ci", checks: [{ name: "test", status: "passed", log: "ok", ms: 4 }] });
      throw new Error(`unexpected mode ${input.mode}`);
    },
  };
  const env = {
    ...vars,
    REPOS: { getByName: () => s.co },
    CHECKER: { getByName: () => checker },
    ARTIFACTS: { get: async () => ({ createToken: async () => ({ plaintext: "read-token" }), info: async () => ({ remote: "https://a/shop" }), [Symbol.dispose]: () => undefined }) },
  };
  const steps: string[] = [];
  const step = {
    do: async <T>(name: string, ...rest: unknown[]) => (steps.push(name), (rest.at(-1) as () => Promise<T>)()),
    sleep: async () => undefined,
  };
  const params = { repo: "shop", pr: pr.id, sha: "f1", run: 1 };
  return { s, pr, env, step, steps, params, containerCalls };
}

test("without Anthropic configuration, CI still runs and gates; every agent step is errored and a human must approve", async () => {
  const w = await wired();
  const out = await runReview(reviewDeps(w.env as never, w.step as never, w.params), w.params);
  assert.deepEqual(out, { outcome: "done" });
  assert.deepEqual(w.containerCalls.map((c) => c.mode), ["snapshot", "ci"]);
  const view = await w.s.co.getPr(w.pr.id);
  assert.equal(view.verdict.ci, "pass");
  assert.equal(view.verdict.review, "incomplete");
  assert.equal(view.verdict.needsHuman, true);
  const classifier = view.checks.find((c) => c.name === "classifier")!;
  assert.equal(classifier.status, "errored");
  assert.match(classifier.log, /agents not configured/);
  assert.equal(view.verdict.mergeable, false);
});

test("each piece of work is its own named Workflow step (so retries and replays are per step)", async () => {
  const w = await wired();
  await runReview(reviewDeps(w.env as never, w.step as never, w.params), w.params);
  assert.ok(w.steps.includes("context") && w.steps.includes("snapshot") && w.steps.includes("ci"), w.steps.join(", "));
  assert.equal(new Set(w.steps).size, w.steps.length, `duplicate step names: ${w.steps.join(", ")}`);
});

test("the container gets a short-lived read token, never one with write scope, for snapshot and CI", async () => {
  const w = await wired();
  await runReview(reviewDeps(w.env as never, w.step as never, w.params), w.params);
  for (const c of w.containerCalls) assert.equal((c as unknown as { repo: { token: string } }).repo.token, "read-token");
});


test("starting an agent session is never retried (a lost response would start a second, untracked, billing session)", async () => {
  const { stepConfig } = await import("../src/review/workflow");
  assert.equal(stepConfig("security: start").retries?.limit, 0);
  assert.equal(stepConfig("verify security 0: start").retries?.limit, 0);
  assert.ok((stepConfig("security: poll 3").retries?.limit ?? 0) > 0);
});

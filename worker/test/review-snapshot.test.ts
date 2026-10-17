import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeAgentClient } from "../src/review/agents/fake";
import { runTimeoutSeconds } from "../src/checker";
import { buildSnapshot } from "../src/review/snapshot";
import type { Pr } from "../src/review/types";

const PR: Pr = {
  id: 3, title: "Fix cart", author: "ann@x", source: "fix", target: "main", state: "ready", head: "h1", base: "m0", createdAt: 1, currentRun: 1,
  intent: { what: "fix totals", why: "bug", testing: "unit test", risk: "low", revert: "revert" },
};

test("the snapshot uploads the archive, the diff and the PR's intent once, and passes the config through", async () => {
  const agents = new FakeAgentClient();
  const calls: unknown[] = [];
  const run = async (input: unknown) => {
    calls.push(input);
    return JSON.stringify({ mode: "snapshot", diff: "+x\n", changedPaths: ["src/a.ts"], tarGzBase64: Buffer.from("TARGZ").toString("base64"), config: { ci: "commands: []\n", review: null, owners: null, reviewMd: "rules" } });
  };
  const snap = await buildSnapshot({ run, ref: { name: "shop", remote: "r", token: "t" }, agents, pr: PR, sha: "h1", since: null });
  assert.deepEqual(Object.keys(snap.fileIds).sort(), ["diff.patch", "pr.json", "repo.tar.gz"]);
  assert.equal(agents.uploads.get(snap.fileIds["repo.tar.gz"]!)!.data, "TARGZ");
  assert.equal(agents.uploads.get(snap.fileIds["diff.patch"]!)!.data, "+x\n");
  assert.deepEqual(JSON.parse(agents.uploads.get(snap.fileIds["pr.json"]!)!.data), { id: 3, title: "Fix cart", source: "fix", target: "main", intent: PR.intent });
  assert.deepEqual(snap.changedPaths, ["src/a.ts"]);
  assert.equal(snap.config.reviewMd, "rules");
  assert.deepEqual(calls[0], { mode: "snapshot", repo: { name: "shop", remote: "r", token: "t" }, branch: "fix", target: "main", sha: "h1", base: "m0", since: null });
});

test("a container error from the snapshot is thrown with its message", async () => {
  await assert.rejects(
    buildSnapshot({ run: async () => JSON.stringify({ error: "archive is 40 MB, over the 25 MB limit" }), ref: { name: "s", remote: "r", token: "t" }, agents: new FakeAgentClient(), pr: PR, sha: "h1", since: null }),
    /over the 25 MB limit/,
  );
});

test("container run limits: CI and merge get their commands' time plus slack, capped at an hour", () => {
  assert.equal(runTimeoutSeconds({ mode: "ci", repo: { name: "", remote: "", token: "" }, branch: "b", sha: "s", commands: [{ name: "a", run: "x", timeoutSeconds: 300 }, { name: "b", run: "y", timeoutSeconds: 600 }] }), 1020);
  assert.equal(runTimeoutSeconds({ mode: "ci", repo: { name: "", remote: "", token: "" }, branch: "b", sha: "s", commands: Array.from({ length: 10 }, (_, i) => ({ name: `${i}`, run: "x", timeoutSeconds: 900 })) }), 3600);
  assert.equal(runTimeoutSeconds({ mode: "snapshot", repo: { name: "", remote: "", token: "" }, branch: "b", target: "main", sha: "s", base: null }), 240);
});

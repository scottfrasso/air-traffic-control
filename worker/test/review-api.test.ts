import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Directory } from "../src/review/directory";
import { handle } from "../src/review/entry";
import { reviewTools } from "../src/review/mcp";
import { routeReviewPush } from "../src/review/routing";
import { sqlStorage } from "./harness/sql";
import { store } from "./harness/store";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-1";

/** A Cloudflare Access stand-in: signs JWTs for an email and serves its key at the team's certs URL. */
async function access() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const kid = `k-${crypto.randomUUID()}`;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid, alg: "RS256" };
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    String(url) === `https://${TEAM}/cdn-cgi/access/certs` ? new Response(JSON.stringify({ keys: [jwk] })) : real(url, init)) as typeof fetch;
  const b64 = (x: string | ArrayBuffer) => Buffer.from(typeof x === "string" ? x : new Uint8Array(x)).toString("base64url");
  return async (email: string) => {
    const head = b64(JSON.stringify({ alg: "RS256", kid }));
    const body = b64(JSON.stringify({ aud: [AUD], email, exp: Math.floor(Date.now() / 1000) + 600, iss: `https://${TEAM}` }));
    return `${head}.${body}.${b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`)))}`;
  };
}

async function app() {
  const s = store("shop");
  await s.init();
  s.heads.set("fix", "f1");
  const directory = new Directory({ storage: { sql: sqlStorage(new DatabaseSync(":memory:")) } } as never, {});
  await directory.addRepo("shop", "ann@x", null);
  const created: string[] = [];
  const signJwt = await access();
  const env = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    REPOS: { getByName: (name: string) => (name === "shop" ? s.co : { init: async () => undefined }) },
    DIRECTORY: { getByName: () => directory },
    ARTIFACTS: {
      create: async (name: string) => (created.push(name), { name, remote: `https://artifacts.example/${name}`, token: "initial" }),
      get: async (name: string) => ({ createToken: async (scope: string) => ({ plaintext: `${scope}-${name}` }), info: async () => ({ remote: `https://artifacts.example/${name}` }), [Symbol.dispose]: () => undefined }),
    },
  };
  const { token } = await directory.createToken("ann@x", "test");
  const { token: bobToken } = await directory.createToken("bob@x", "test");
  const call = async (method: string, path: string, body?: unknown, as = token) => {
    const res = await handle(new Request(`https://atc.example${path}`, { method, headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never, {} as never);
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
  };
  /** The same call, signed in through Access as `email` (a person at the web UI). */
  const asPerson = async (email: string, method: string, path: string, body?: unknown) => {
    const res = await handle(new Request(`https://atc.example${path}`, { method, headers: { "cf-access-jwt-assertion": await signJwt(email), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never, {} as never);
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
  };
  return { s, env, directory, created, call, asPerson, token, bobToken };
}

test("the API needs a person: no token, no access", async () => {
  const a = await app();
  const res = await handle(new Request("https://atc.example/api/repos"), a.env as never, {} as never);
  assert.equal(res.status, 401);
});

test("GET /api/me names the token's person", async () => {
  const a = await app();
  assert.deepEqual((await a.call("GET", "/api/me")).body, { email: "ann@x", name: "ann", via: "token" });
  assert.deepEqual((await a.asPerson("ann@x", "GET", "/api/me")).body, { email: "ann@x", name: "ann", via: "access" });
});

test("creating a repo creates it in Artifacts and lists it; a second time is a 409", async () => {
  const a = await app();
  const r = await a.call("POST", "/api/repos", { name: "billing" });
  assert.equal(r.status, 201);
  assert.deepEqual(a.created, ["billing"]);
  const repos = (await a.call("GET", "/api/repos")).body.repos as Array<{ name: string; created_by: string }>;
  assert.deepEqual(repos.map((r) => [r.name, r.created_by]), [["billing", "ann@x"], ["shop", "ann@x"]]);
  assert.equal((await a.call("POST", "/api/repos", { name: "billing" })).status, 409);
});

test("an invalid repo name is a 400", async () => {
  const a = await app();
  assert.equal((await a.call("POST", "/api/repos", { name: "../etc" })).status, 400);
});

test("git credentials: a write token for the repo, and the commands to use it", async () => {
  const a = await app();
  const r = await a.call("POST", "/api/repos/shop/git-credentials");
  assert.equal(r.status, 200);
  assert.equal(r.body.remote, "https://artifacts.example/shop");
  assert.equal(r.body.token, "write-shop");
  assert.match(String((r.body.commands as Record<string, string>).push), /http\.extraHeader="Authorization: Bearer write-shop".*push/);
});

test("opening a PR makes the caller its author, whatever the body says", async () => {
  const a = await app();
  const r = await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix", author: "mallory@x" });
  assert.equal(r.status, 201);
  assert.equal(r.body.author, "ann@x");
});

test("a PR's lifecycle over HTTP: ready starts a run; approve needs the current head; merge reports blockers", async () => {
  const a = await app();
  const pr = (await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" })).body as { id: number };
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/ready`)).status, 200);
  assert.equal(a.s.runs.length, 1);
  const viaToken = await a.call("POST", `/api/repos/shop/prs/${pr.id}/approve`, { sha: "f1" }, a.bobToken);
  assert.equal(viaToken.status, 403); // a token could be an agent's
  const stale = await a.asPerson("bob@x", "POST", `/api/repos/shop/prs/${pr.id}/approve`, { sha: "old" });
  assert.equal(stale.status, 409);
  assert.match(String(stale.body.error), /review the current head/);
  assert.equal((await a.asPerson("bob@x", "POST", `/api/repos/shop/prs/${pr.id}/approve`, { sha: "f1" })).status, 200);
  const view = (await a.call("GET", `/api/repos/shop/prs/${pr.id}`)).body as { approvals: Array<{ by: string }> };
  assert.deepEqual(view.approvals.map((x) => x.by), ["bob@x"]);
  const merge = await a.call("POST", `/api/repos/shop/prs/${pr.id}/merge`);
  assert.equal(merge.status, 409);
  assert.ok((merge.body.blockers as string[]).includes("review in progress"));
});

test("resolving a finding needs a valid kind and a reason", async () => {
  const a = await app();
  const pr = (await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" })).body as { id: number };
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/findings/1/resolve`, { kind: "meh", reason: "x" })).status, 400);
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/findings/1/resolve`, { kind: "wrong", reason: "x" })).status, 409); // no such finding
});

test("an unknown repo is a 404", async () => {
  const a = await app();
  assert.equal((await a.call("GET", "/api/repos/nope/prs")).status, 404);
});

test("tokens: created once in plain text, then listed without it, and revocable", async () => {
  const a = await app();
  const made = await a.call("POST", "/api/tokens", { label: "laptop" });
  assert.equal(made.status, 201);
  assert.match(String(made.body.token), /^atc_/);
  const list = (await a.call("GET", "/api/tokens")).body.tokens as Array<{ id: number; label: string }>;
  assert.ok(list.some((t) => t.label === "laptop"));
  assert.equal(JSON.stringify(list).includes(String(made.body.token)), false);
  assert.equal((await a.call("DELETE", `/api/tokens/${made.body.id}`)).status, 200);
  assert.equal((await a.call("GET", "/api/me", undefined, String(made.body.token))).status, 401);
});

test("a push to any branch of a repo reaches its store", async () => {
  const a = await app();
  const pr = (await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" })).body as { id: number };
  a.s.heads.set("fix", "f2");
  await routeReviewPush(a.env as never, { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "agentmesh", repoName: "shop" }, payload: { ref: "refs/heads/fix", before: "f1", after: "f2", commits: [], totalCommitsCount: 0, commitsTruncated: false }, metadata: {} } as never);
  assert.equal((await a.s.co.getPr(pr.id)).pr.head, "f2");
});

test("MCP get_pr gives the verdict and open findings, acting as the token's person", async () => {
  const a = await app();
  const tools = reviewTools(a.env as never, { email: "ann@x", name: "ann" });
  const opened = (await tools.open_pr({ repo: "shop", title: "Fix cart", source: "fix" })) as { id: number; author: string };
  assert.equal(opened.author, "ann@x");
  await tools.mark_ready({ repo: "shop", pr: opened.id });
  const view = (await tools.get_pr({ repo: "shop", pr: opened.id })) as { state: string; verdict: { review: string }; openFindings: unknown[] };
  assert.deepEqual([view.state, view.verdict.review, view.openFindings.length], ["ready", "pending", 0]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Directory } from "../src/review/directory";
import { handle } from "../src/review/entry";
import { forgetAccessKeys } from "../src/review/identity";
import { reviewTools } from "../src/review/mcp";
import { routeReviewPush } from "../src/review/routing";
import { sqlStorage } from "./harness/sql";
import { store } from "./harness/store";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-1";

/** A Cloudflare Access stand-in: signs JWTs for an email and serves its key at the team's certs URL. */
async function access() {
  forgetAccessKeys();
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
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
  const asPerson = async (email: string, method: string, path: string, body?: unknown, origin: string | null = "https://atc.example") => {
    const res = await handle(new Request(`https://atc.example${path}`, { method, headers: { "cf-access-jwt-assertion": await signJwt(email), "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never, {} as never);
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
  assert.match(String((r.body.commands as Record<string, string>).push), /GIT_CONFIG_VALUE_0="Authorization: Bearer write-shop"; git push /);
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
  const made = await a.asPerson("ann@x", "POST", "/api/tokens", { label: "laptop" });
  assert.equal(made.status, 201);
  assert.match(String(made.body.token), /^atc_/);
  const list = (await a.call("GET", "/api/tokens")).body.tokens as Array<{ id: number; label: string }>;
  assert.ok(list.some((t) => t.label === "laptop"));
  assert.equal(JSON.stringify(list).includes(String(made.body.token)), false);
  assert.equal((await a.asPerson("ann@x", "DELETE", `/api/tokens/${made.body.id}`)).status, 200);
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

test("the admin secret mints a personal token for an email (an ordinary token: it still can't approve); a wrong or unset secret is refused", async () => {
  const a = await app();
  const mint = (secret: string | undefined, env: Record<string, unknown>) =>
    handle(new Request("https://atc.example/api/admin/tokens", { method: "POST", headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ email: "Scott@X", label: "e2e" }) }), env as never, {} as never);
  assert.equal((await mint("s3cret-admin-0123456789abcdef0123456789", a.env)).status, 401, "no ADMIN_SECRET configured: refused");
  const env = { ...a.env, ADMIN_SECRET: "s3cret-admin-0123456789abcdef0123456789" };
  assert.equal((await mint("wrong", env)).status, 401);
  assert.equal((await mint(undefined, env)).status, 401);
  const res = await mint("s3cret-admin-0123456789abcdef0123456789", env);
  assert.equal(res.status, 201);
  const { token } = (await res.json()) as { token: string };
  assert.match(token, /^atc_/);
  const who = await handle(new Request("https://atc.example/api/tokens", { headers: { authorization: `Bearer ${token}` } }), env as never, {} as never);
  assert.equal(who.status, 200, "the minted token is a working personal token");
  assert.equal((await a.directory.personForToken(await hashOf(token)))?.email, "scott@x");
  // The admin secret itself is not a personal token: it can't call anything else.
  assert.equal((await handle(new Request("https://atc.example/api/repos", { headers: { authorization: "Bearer s3cret-admin-0123456789abcdef0123456789" } }), env as never, {} as never)).status, 401);
});

async function hashOf(token: string) {
  return (await import("../src/review/identity")).hashToken(token);
}

test("run checks over HTTP: the whole gauntlet, or single checks; the wrong commit or an unknown check is refused", async () => {
  const a = await app();
  const pr = (await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" })).body as { id: number };
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`, { sha: "f0" })).status, 409);
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`, { only: ["lint"] })).status, 400);
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`, { only: "security" })).status, 400);
  const r = await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`, { sha: "f1", only: ["security"] });
  assert.equal(r.status, 200);
  assert.deepEqual(a.s.runs.map((x) => x.params.only), [["security"]]);
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`)).status, 200);
  assert.deepEqual(a.s.runs.map((x) => x.params.only ?? "all"), [["security"], "all"]);
});

test("GET /api/prs lists every repo's PRs for the dashboard, newest activity first, with a compact verdict", async () => {
  const a = await app();
  const one = (await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" })).body as { id: number };
  await a.call("POST", `/api/repos/shop/prs/${one.id}/checks`);
  const r = await a.call("GET", "/api/prs");
  assert.equal(r.status, 200);
  const prs = r.body.prs as Array<{ repo: string; pr: { id: number; title: string; state: string }; verdict: { checks: string; blockers: string[] }; findings: { important: number; nit: number }; steps: Array<{ name: string; status: string }>; updatedAt: number }>;
  assert.equal(prs.length, 1);
  assert.deepEqual([prs[0]!.repo, prs[0]!.pr.title, prs[0]!.pr.state, prs[0]!.verdict.checks], ["shop", "Fix cart", "ready", "running"]);
  assert.deepEqual(prs[0]!.findings, { important: 0, nit: 0 });
  assert.ok(prs[0]!.updatedAt > 0);
});

test("MCP run_checks runs the gauntlet on the head, or single checks, as the token's person", async () => {
  const a = await app();
  const tools = reviewTools(a.env as never, { email: "ann@x", name: "ann" });
  const opened = (await tools.open_pr({ repo: "shop", title: "Fix cart", source: "fix" })) as { id: number };
  await tools.run_checks({ repo: "shop", pr: opened.id, only: ["ci"] });
  await tools.run_checks({ repo: "shop", pr: opened.id, sha: "f1" });
  assert.deepEqual(a.s.runs.map((x) => x.params.only ?? "all"), [["ci"], "all"]);
  const view = (await tools.get_pr({ repo: "shop", pr: opened.id })) as { verdict: { checks: string } };
  assert.equal(view.verdict.checks, "running");
});

test("run checks rejects a null body and an empty only list with a 400", async () => {
  const a = await app();
  const pr = (await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" })).body as { id: number };
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`, null)).status, 400);
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`, { only: [] })).status, 400);
  assert.equal(a.s.runs.length, 0);
});

test("the dashboard still lists the other repos when one repo's store fails", async () => {
  const a = await app();
  await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" });
  await a.directory.addRepo("broken", "ann@x", null);
  const real = a.env.REPOS.getByName;
  a.env.REPOS.getByName = ((name: string) => (name === "broken" ? { listSummaries: async () => { throw new Error("down"); } } : real(name))) as never;
  const r = await a.call("GET", "/api/prs");
  assert.equal(r.status, 200);
  assert.deepEqual((r.body.prs as Array<{ repo: string }>).map((p) => p.repo), ["shop"]);
  assert.deepEqual(r.body.unavailable, ["broken"]);
});

test("MCP run_checks tells agents to poll until checks aren't running (a partial or stale run never says done)", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/review/mcp.ts", import.meta.url), "utf8");
  assert.match(src, /until verdict\.checks isn't running/);
  assert.doesNotMatch(src, /until verdict\.checks is done/);
});


test("CSRF: a browser request that changes something must come from this site, as JSON", async () => {
  const a = await app();
  const pr = (await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" })).body as { id: number };
  await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`);
  assert.equal((await a.asPerson("bob@x", "POST", `/api/repos/shop/prs/${pr.id}/approve`, { sha: "f1" }, "https://evil.example")).status, 403);
  assert.equal((await a.asPerson("bob@x", "POST", `/api/repos/shop/prs/${pr.id}/approve`, { sha: "f1" }, null)).status, 403);
  const form = await handle(new Request(`https://atc.example/api/repos/shop/prs/${pr.id}/merge`, { method: "POST", headers: { "cf-access-jwt-assertion": "x", origin: "https://atc.example", "content-type": "text/plain" }, body: "{}" }), a.env as never, {} as never);
  assert.equal(form.status, 403, "a text/plain form post is refused before anything else");
  assert.equal((await a.asPerson("bob@x", "POST", `/api/repos/shop/prs/${pr.id}/approve`, { sha: "f1" })).status, 200);
  assert.equal((await a.asPerson("bob@x", "GET", `/api/repos/shop/prs/${pr.id}`, undefined, null)).status, 200, "reads don't need it");
});

test("only an Access sign-in creates or revokes tokens: a token (maybe an agent's) can't mint more", async () => {
  const a = await app();
  assert.equal((await a.call("POST", "/api/tokens", { label: "more" })).status, 403);
  assert.equal((await a.call("DELETE", "/api/tokens/1")).status, 403);
});

test("a short admin secret disables the admin endpoint", async () => {
  const a = await app();
  const env = { ...a.env, ADMIN_SECRET: "short" };
  const res = await handle(new Request("https://atc.example/api/admin/tokens", { method: "POST", headers: { authorization: "Bearer short", "content-type": "application/json" }, body: JSON.stringify({ email: "x@x" }) }), env as never, {} as never);
  assert.equal(res.status, 401);
});

test("MCP refuses repos that aren't registered", async () => {
  const a = await app();
  const tools = reviewTools(a.env as never, { email: "ann@x", name: "ann" });
  await assert.rejects(tools.get_pr({ repo: "nope", pr: 1 }), /no repo nope/);
});

test("a malformed percent-escape in a path is a 400, not a 500", async () => {
  const a = await app();
  assert.equal((await a.call("GET", "/api/repos/%E0%A4%A/prs")).status, 400);
});

test("the web UI's own pages are served as HTML, /settings included", async () => {
  const a = await app();
  for (const path of ["/", "/settings", "/repos/shop", "/repos/shop/prs/1"]) {
    const res = await handle(new Request(`https://atc.example${path}`), a.env as never, {} as never);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
  }
});

test("hitting the daily run cap is a 429", async () => {
  const a = await app();
  (a.s.co as unknown as { env: Record<string, unknown> }).env.REVIEW_MAX_RUNS_PER_DAY = "1";
  const pr = (await a.call("POST", "/api/repos/shop/prs", { title: "Fix cart", source: "fix" })).body as { id: number };
  await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`, { only: ["ci"] });
  assert.equal((await a.call("POST", `/api/repos/shop/prs/${pr.id}/checks`)).status, 429);
});

test("git credentials never put the token on a git command line (shell history, ps)", async () => {
  const a = await app();
  const r = await a.call("POST", "/api/repos/shop/git-credentials");
  for (const cmd of Object.values(r.body.commands as Record<string, string>)) assert.doesNotMatch(cmd, /git -c http\.extraHeader/);
  assert.match(String((r.body.commands as Record<string, string>).push), /GIT_CONFIG_VALUE_0/);
});

test("a person can create at most 50 repos", async () => {
  const a = await app();
  for (let i = 0; i < 49; i++) await a.directory.addRepo(`r${i}`, "ann@x", null);
  assert.equal((await a.call("POST", "/api/repos", { name: "one-more" })).status, 429);
});

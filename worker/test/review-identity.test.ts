import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Directory } from "../src/review/directory";
import { hashToken, personFromRequest, verifyAccessJwt } from "../src/review/identity";
import { sqlStorage } from "./harness/sql";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-123";
const b64url = (data: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? data : data instanceof Uint8Array ? data : new Uint8Array(data)).toString("base64url");

async function signer() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const id = `k-${crypto.randomUUID()}`; // Access key ids are unique; the verifier caches keys by team
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: id, alg: "RS256" };
  const sign = async (claims: Record<string, unknown>, kid = id) => {
    const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const body = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(sig)}`;
  };
  const certs = (async (url: string | URL | Request) => {
    assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
  return { sign, certs };
}

const claims = (over: Record<string, unknown> = {}) => ({ aud: [AUD], email: "ann@x.dev", exp: Math.floor(Date.now() / 1000) + 600, iss: `https://${TEAM}`, ...over });

function directory() {
  const db = new DatabaseSync(":memory:");
  return { d: new Directory({ storage: { sql: sqlStorage(db) } } as never, {} as never), db };
}

test("a valid Access JWT names the person", async () => {
  const s = await signer();
  assert.equal(await verifyAccessJwt(await s.sign(claims()), { teamDomain: TEAM, aud: AUD }, s.certs), "ann@x.dev");
});

test("an Access JWT for another application (wrong aud) is rejected", async () => {
  const s = await signer();
  assert.equal(await verifyAccessJwt(await s.sign(claims({ aud: ["other"] })), { teamDomain: TEAM, aud: AUD }, s.certs), null);
});

test("an expired Access JWT is rejected", async () => {
  const s = await signer();
  assert.equal(await verifyAccessJwt(await s.sign(claims({ exp: Math.floor(Date.now() / 1000) - 5 })), { teamDomain: TEAM, aud: AUD }, s.certs), null);
});

test("a tampered Access JWT (bad signature) is rejected", async () => {
  const s = await signer();
  const [h, , sig] = (await s.sign(claims())).split(".");
  const forged = `${h}.${b64url(JSON.stringify(claims({ email: "mallory@x.dev" })))}.${sig}`;
  assert.equal(await verifyAccessJwt(forged, { teamDomain: TEAM, aud: AUD }, s.certs), null);
});

test("a JWT signed with an unknown key is rejected", async () => {
  const s = await signer();
  assert.equal(await verifyAccessJwt(await s.sign(claims(), "k9"), { teamDomain: TEAM, aud: AUD }, s.certs), null);
});

test("personal tokens: shown once, stored only as a hash, and map to their person until revoked", async () => {
  const { d, db } = directory();
  const { token, id } = await d.createToken("ann@x.dev", "laptop agent");
  assert.match(token, /^atc_[A-Za-z0-9_-]{43}$/);
  const rows = db.prepare("SELECT * FROM tokens").all() as Array<Record<string, unknown>>;
  assert.equal(JSON.stringify(rows).includes(token), false);
  assert.equal(rows[0]!.hash, await hashToken(token));
  assert.deepEqual(await d.personForToken(await hashToken(token)), { email: "ann@x.dev", name: "ann" });
  assert.deepEqual((await d.listTokens("ann@x.dev")).map((t) => [t.id, t.label]), [[id, "laptop agent"]]);
  await d.revokeToken("bob@x.dev", id); // not his: no effect
  assert.ok(await d.personForToken(await hashToken(token)));
  await d.revokeToken("ann@x.dev", id);
  assert.equal(await d.personForToken(await hashToken(token)), null);
});

test("a request with a personal token is its person; with an Access JWT, the JWT's email; with neither, nobody", async () => {
  const s = await signer();
  const { d } = directory();
  const { token } = await d.createToken("bob@x.dev", "ci");
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  assert.equal((await personFromRequest(new Request("https://x/api/repos", { headers: { authorization: `Bearer ${token}` } }), env, d, s.certs))?.email, "bob@x.dev");
  assert.equal((await personFromRequest(new Request("https://x/", { headers: { "cf-access-jwt-assertion": await s.sign(claims()) } }), env, d, s.certs))?.email, "ann@x.dev");
  assert.equal(await personFromRequest(new Request("https://x/"), env, d, s.certs), null);
  assert.equal(await personFromRequest(new Request("https://x/", { headers: { authorization: "Bearer atc_nope" } }), env, d, s.certs), null);
});

test("without Access configured, a JWT header is ignored (never trusted unverified)", async () => {
  const s = await signer();
  const { d } = directory();
  assert.equal(await personFromRequest(new Request("https://x/", { headers: { "cf-access-jwt-assertion": await s.sign(claims()) } }), {}, d, s.certs), null);
});

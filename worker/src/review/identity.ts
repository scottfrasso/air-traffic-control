import type { Directory } from "./directory";

/**
 * Who is calling. People reach the web UI through Cloudflare Access (a verified email on every request); people and
 * the coding agents they direct use the API with personal tokens. An agent's actions are its person's actions.
 */

export interface Person {
  email: string;
  name: string;
}

export const TOKEN_PREFIX = "atc_";

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;

type Jwk = JsonWebKey & { kid?: string };
const certCache = new Map<string, { at: number; keys: Jwk[] }>();
const CERT_TTL_MS = 10 * 60_000;

async function accessKeys(teamDomain: string, fetchImpl: typeof fetch, fresh = false): Promise<Jwk[]> {
  const hit = certCache.get(teamDomain);
  if (!fresh && hit && hit.at > Date.now() - CERT_TTL_MS) return hit.keys;
  const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
  certCache.set(teamDomain, { at: Date.now(), keys });
  return keys;
}

/** The email in a valid Cloudflare Access JWT for this application, or null (bad signature, wrong aud, expired, unknown key). */
export async function verifyAccessJwt(jwt: string, cfg: { teamDomain: string; aud: string }, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) return null;
    const header = b64urlJson(h);
    if (header.alg !== "RS256") return null;
    let jwk = (await accessKeys(cfg.teamDomain, fetchImpl)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(cfg.teamDomain, fetchImpl, true)).find((k) => k.kid === header.kid); // keys rotate
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`)))) return null;
    const claims = b64urlJson(p);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.aud)) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    if (claims.iss !== undefined && claims.iss !== `https://${cfg.teamDomain}`) return null;
    return typeof claims.email === "string" && claims.email ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface IdentityEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

/** The person behind a request, or null. A personal token wins; else a verified Access JWT; never an unverified header. */
export async function personFromRequest(
  request: Request,
  env: IdentityEnv,
  directory: Pick<Directory, "personForToken" | "ensurePerson">,
  fetchImpl: typeof fetch = fetch,
): Promise<Person | null> {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith(`Bearer ${TOKEN_PREFIX}`)) return directory.personForToken(await hashToken(auth.slice(7).trim()));
  const jwt = request.headers.get("cf-access-jwt-assertion") ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const email = await verifyAccessJwt(jwt, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }, fetchImpl);
  return email ? directory.ensurePerson(email) : null;
}

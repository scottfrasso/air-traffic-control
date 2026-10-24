import { handleApi, type ApiEnv } from "./api";
import { hashToken, personFromRequest, type IdentityEnv } from "./identity";
import { handleReviewMcp } from "./mcp";
import ui from "./ui.html";

export type ReviewWorkerEnv = ApiEnv & IdentityEnv & {
  /** Temporary bootstrap until Access is set up: mints personal tokens from the command line. Unset = off. */
  ADMIN_SECRET?: string;
};

/**
 * POST /api/admin/tokens {email, label?} with `Authorization: Bearer <ADMIN_SECRET>`: a personal token for that email.
 * It is an ordinary token (via "token"), so it can't approve or dismiss important findings; only Access sign-ins can.
 */
async function mintToken(request: Request, env: ReviewWorkerEnv): Promise<Response> {
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "");
  // Compare digests, so the comparison takes the same time however much of the secret matches.
  // A short secret turns the endpoint off: it can mint a token for anyone (security review, 10-17).
  if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 32 || !given || (await hashToken(given)) !== (await hashToken(env.ADMIN_SECRET))) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; label?: unknown };
  if (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(body.email)) return Response.json({ error: "email required" }, { status: 400 });
  const directory = env.DIRECTORY.getByName("directory");
  const person = await directory.ensurePerson(body.email.toLowerCase());
  return Response.json(await directory.createToken(person.email, typeof body.label === "string" ? body.label : "admin"), { status: 201 });
}

/** The web UI's own pages (one HTML shell; the script routes). */
const UI_PAGES = /^\/(?:settings\/?|repos\/.+)?$/;

/**
 * CSRF: Access authenticates a browser by its cookie, which a page on another site can make it send. So a request
 * that changes something, unless it carries a bearer token (scripts and agents, not browsers), must come from this
 * site (Origin) and be JSON (a cross-site form can't send that without a CORS preflight, which we never answer).
 */
function sameSiteWrite(request: Request, url: URL): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return true;
  if ((request.headers.get("authorization") ?? "").startsWith("Bearer ")) return true;
  const origin = request.headers.get("origin");
  const json = (request.headers.get("content-type") ?? "").split(";")[0]!.trim() === "application/json";
  return origin === url.origin && json;
}

const unauthorized = () =>
  Response.json({ error: "sign in through Cloudflare Access, or send Authorization: Bearer <personal token>" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

/**
 * The review pipeline's HTTP surface: the web UI (a static shell; data comes from the API), the JSON API, and MCP
 * for coding agents. Everything but the shell and /health needs a person (Access JWT or personal token).
 */
/** The UI's one inline script, allowed by its hash rather than 'unsafe-inline' (security review, 10-23). */
let scriptHash: Promise<string> | null = null;
const uiScriptHash = () =>
  (scriptHash ??= (async () => {
    const inline = /<script>([\s\S]*?)<\/script>/.exec(ui)?.[1] ?? "";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inline)));
    return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
  })());

export async function handle(request: Request, env: ReviewWorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const res = await route(request, env, ctx);
  // Nothing we send is meant to be sniffed into another type. (A copy: some responses' headers are immutable.)
  const out = new Response(res.body, res);
  out.headers.set("x-content-type-options", "nosniff");
  return out;
}

async function route(request: Request, env: ReviewWorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (request.method === "POST" && url.pathname === "/api/admin/tokens") return mintToken(request, env);
  if (request.method === "GET" && UI_PAGES.test(url.pathname))
    return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'self'; script-src 'self' ${await uiScriptHash()}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'` } });
  if (!sameSiteWrite(request, url)) return Response.json({ error: "cross-site request refused: send JSON from this site" }, { status: 403 });
  const directory = env.DIRECTORY.getByName("directory");
  const person = await personFromRequest(request, env, directory);
  if (!person) return unauthorized();
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, person, directory);
  if (url.pathname === "/mcp") return handleReviewMcp(request, env, ctx, person);
  return Response.json({ error: "not found" }, { status: 404 });
}

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
  if (!env.ADMIN_SECRET || !given || (await hashToken(given)) !== (await hashToken(env.ADMIN_SECRET))) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; label?: unknown };
  if (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(body.email)) return Response.json({ error: "email required" }, { status: 400 });
  const directory = env.DIRECTORY.getByName("directory");
  const person = await directory.ensurePerson(body.email.toLowerCase());
  return Response.json(await directory.createToken(person.email, typeof body.label === "string" ? body.label : "admin"), { status: 201 });
}

const unauthorized = () =>
  Response.json({ error: "sign in through Cloudflare Access, or send Authorization: Bearer <personal token>" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

/**
 * The review pipeline's HTTP surface: the web UI (a static shell; data comes from the API), the JSON API, and MCP
 * for coding agents. Everything but the shell and /health needs a person (Access JWT or personal token).
 */
export async function handle(request: Request, env: ReviewWorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (request.method === "POST" && url.pathname === "/api/admin/tokens") return mintToken(request, env);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/repos/")))
    return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'" } });
  const directory = env.DIRECTORY.getByName("directory");
  const person = await personFromRequest(request, env, directory);
  if (!person) return unauthorized();
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, person, directory);
  if (url.pathname === "/mcp") return handleReviewMcp(request, env, ctx, person);
  return Response.json({ error: "not found" }, { status: 404 });
}

import { handleApi, type ApiEnv } from "./api";
import { personFromRequest, type IdentityEnv } from "./identity";
import { handleReviewMcp } from "./mcp";
import ui from "./ui.html";

export type ReviewWorkerEnv = ApiEnv & IdentityEnv;

const unauthorized = () =>
  Response.json({ error: "sign in through Cloudflare Access, or send Authorization: Bearer <personal token>" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

/**
 * The review pipeline's HTTP surface: the web UI (a static shell; data comes from the API), the JSON API, and MCP
 * for coding agents. Everything but the shell and /health needs a person (Access JWT or personal token).
 */
export async function handle(request: Request, env: ReviewWorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/repos/")))
    return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" } });
  const directory = env.DIRECTORY.getByName("directory");
  const person = await personFromRequest(request, env, directory);
  if (!person) return unauthorized();
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, person, directory);
  if (url.pathname === "/mcp") return handleReviewMcp(request, env, ctx, person);
  return Response.json({ error: "not found" }, { status: 404 });
}

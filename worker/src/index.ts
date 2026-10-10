import { handleApi } from "./api";
import { handleMcp } from "./mcp";
import { baselineOf } from "./artifacts";
import { isAuthorized, unauthorized } from "./auth";
import dashboardHtml from "./dashboard.html";
import { isPushed, type ArtifactsEvent } from "./events";

export { Coordinator } from "./coordinator";
export { PushPipeline } from "./pipeline";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // Static shell only; it holds no data and asks for the API key (ADR-0005).
    if (url.pathname === "/" || url.pathname.startsWith("/r/")) return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (!isAuthorized(request, env)) return unauthorized();
    if (url.pathname.startsWith("/api/repos/")) return handleApi(request, env, url);
    if (url.pathname === "/mcp") return handleMcp(request, env, ctx);
    return Response.json({ error: "not found" }, { status: 404 });
  },

  /** Artifacts event subscriptions deliver here (ADR-0002). */
  async queue(batch, env): Promise<void> {
    for (const msg of batch.messages) {
      const event = msg.body;
      if (isPushed(event)) {
        const e = event;
        const repo = e.source.repoName;
        if (e.payload.ref === "refs/heads/main") {
          const stub = env.COORDINATOR.getByName(baselineOf(repo));
          await stub.ensure(baselineOf(repo));
          await stub.onPush(repo, e.payload.after, "event", e);
        }
      }
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, ArtifactsEvent>;

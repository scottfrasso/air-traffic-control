import { handleApi } from "./api";
import { handleMcp } from "./mcp";
import { isAuthorized, unauthorized } from "./auth";
import { publicReplayBaseline } from "./public";
import dashboardHtml from "./dashboard.html";
import type { ArtifactsEvent } from "./events";
import { consumeBatch, routePushEvent } from "./queue";

export { Coordinator } from "./coordinator";
export { PushPipeline } from "./pipeline";
export { Checker } from "./checker";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // Static shell only; it holds no data and asks for the API key (ADR-0005).
    if (url.pathname === "/" || url.pathname.startsWith("/r/")) return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    // Key-less read-only replay of allow-listed recorded runs (issue #14).
    const publicBaseline = publicReplayBaseline(request.method, url.pathname, env.PUBLIC_REPLAY_BASELINES);
    if (publicBaseline) {
      // Edge-cached for a minute so anonymous traffic doesn't wake the Coordinator on every request.
      const cacheKey = new Request(url.origin + url.pathname, { method: "GET" });
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      try {
        const body = await env.COORDINATOR.getByName(publicBaseline).timelineJson();
        const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
        ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
        return res;
      } catch {
        return Response.json({ error: "replay unavailable" }, { status: 503 });
      }
    }
    if (!isAuthorized(request, env)) return unauthorized();
    if (url.pathname.startsWith("/api/repos/")) return handleApi(request, env, url);
    if (url.pathname === "/mcp") return handleMcp(request, env, ctx);
    return Response.json({ error: "not found" }, { status: 404 });
  },

  /** Artifacts event subscriptions deliver here (ADR-0002). Each message is acked or retried on its own (issue #7). */
  async queue(batch, env): Promise<void> {
    await consumeBatch(batch.messages, (event) => routePushEvent(env, event));
  },
} satisfies ExportedHandler<Env, ArtifactsEvent>;

import { isAuthorized, unauthorized } from "./auth";
import type { ArtifactsEvent } from "./events";

export { Coordinator } from "./coordinator";

const coordinator = (env: Env, baseline: string) => env.COORDINATOR.getByName(baseline);

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (!isAuthorized(request, env)) return unauthorized();
    const m = /^\/api\/repos\/([^/]+)\/events$/.exec(url.pathname);
    if (m?.[1]) return Response.json(await coordinator(env, m[1]).events());
    return new Response("agentmesh", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    for (const msg of batch.messages) {
      const event = msg.body;
      // Spike: fork names are "<baseline>--<agent>"; route to the baseline's coordinator.
      const baseline = event.source.repoName.split("--")[0] ?? event.source.repoName;
      await coordinator(env, baseline).recordArtifactsEvent(event);
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, ArtifactsEvent>;

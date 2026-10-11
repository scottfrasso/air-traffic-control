import type { Coordinator } from "./coordinator";
import { startFork } from "./forks";

type Handler = (stub: DurableObjectStub<Coordinator>, request: Request, url: URL, ctx: { env: Env; baseline: string }) => Promise<Response>;

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const routes: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  ["GET", /^\/state$/, async (stub) => new Response(await stub.stateJson(), { headers: { "content-type": "application/json" } })],
  [
    "POST",
    /^\/forks$/,
    async (_stub, request, _url, { env, baseline }) => {
      const { agent } = await body<{ agent?: string }>(request);
      if (!agent || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(agent)) throw new HttpError(400, "agent must match ^[a-z0-9][a-z0-9-]{0,30}$");
      return json(await startFork(env, baseline, agent), 201);
    },
  ],
  ["DELETE", /^\/forks\/([^/]+)$/, async (stub, _r, url) => (await stub.abandonFork(decodeURIComponent(url.pathname.split("/").pop() ?? "")), json({ ok: true }))],
  [
    "POST",
    /^\/intents$/,
    async (stub, request) => {
      const b = await body<{ fork?: string; description?: string; files?: string[]; symbols?: string[] }>(request);
      if (!b.fork || !b.description) throw new HttpError(400, "fork and description are required");
      return json(await stub.declareIntent(b.fork, b.description, b.files ?? [], b.symbols ?? []));
    },
  ],
  [
    "GET",
    /^\/signals$/,
    async (stub, _r, url) => {
      const fork = url.searchParams.get("fork");
      if (!fork) throw new HttpError(400, "fork query parameter is required");
      return json(await stub.getSignals(fork, url.searchParams.get("all") === "1"));
    },
  ],
  [
    "POST",
    /^\/land$/,
    async (stub, request) => {
      const { fork } = await body<{ fork?: string }>(request);
      if (!fork) throw new HttpError(400, "fork is required");
      return json(await stub.requestLand(fork));
    },
  ],
  [
    "GET",
    /^\/clearance$/,
    async (stub, _r, url) => {
      const fork = url.searchParams.get("fork");
      if (!fork) throw new HttpError(400, "fork query parameter is required");
      return json(await stub.getClearance(fork));
    },
  ],
  ["GET", /^\/history$/, async (stub, _r, url) => json(await stub.getHistory(url.searchParams.get("fork") ?? undefined))],
  ["GET", /^\/timeline$/, async (stub) => new Response(await stub.timelineJson(), { headers: { "content-type": "application/json" } })],
  ["GET", /^\/webhooks$/, async (stub) => json(await stub.listWebhooks())],
  [
    "POST",
    /^\/webhooks$/,
    async (stub, request) => {
      const b = await body<{ url?: string; secret?: string }>(request);
      if (!b.url) throw new HttpError(400, "url is required");
      return json(await stub.addWebhook(b.url, b.secret ?? null), 201);
    },
  ],
  ["DELETE", /^\/webhooks$/, async (stub, _r, url) => (await stub.removeWebhook(url.searchParams.get("url") ?? ""), json({ ok: true }))],
  ["POST", /^\/reconcile$/, async (stub) => json({ found: await stub.reconcile() })],
];

/** `/api/repos/:baseline/...` → Coordinator for that baseline. */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const m = /^\/api\/repos\/([A-Za-z0-9][A-Za-z0-9._-]{0,62})(\/.*)$/.exec(url.pathname);
  if (!m?.[1] || !m[2]) return json({ error: "not found" }, 404);
  const baseline = m[1];
  const rest = m[2];
  const stub = env.COORDINATOR.getByName(baseline);
  if (rest === "/live") {
    // Live push to the dashboard: WebSocket served by the Coordinator (hibernatable).
    await stub.ensure(baseline);
    return stub.fetch(request);
  }
  const route = routes.find(([method, pattern]) => method === request.method && pattern.test(rest));
  if (!route) return json({ error: "not found" }, 404);
  try {
    await stub.ensure(baseline);
    return await route[2](stub, request, new URL(rest + url.search, url), { env, baseline });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    return json({ error: (err as Error).message }, 500);
  }
}

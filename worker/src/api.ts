import type { Coordinator } from "./coordinator";

type Handler = (stub: DurableObjectStub<Coordinator>, request: Request, url: URL) => Promise<Response>;

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
  ["GET", /^\/state$/, async (stub) => json(await stub.state())],
  [
    "POST",
    /^\/forks$/,
    async (stub, request) => {
      const { agent } = await body<{ agent?: string }>(request);
      if (!agent || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(agent)) throw new HttpError(400, "agent must match ^[a-z0-9][a-z0-9-]{0,30}$");
      return json(await stub.createFork(agent), 201);
    },
  ],
  ["DELETE", /^\/forks\/([^/]+)$/, async (stub, _r, url) => (await stub.abandonFork(decodeURIComponent(url.pathname.split("/").pop() ?? "")), json({ ok: true }))],
  ["POST", /^\/reconcile$/, async (stub) => json({ found: await stub.reconcile() })],
];

/** `/api/repos/:baseline/...` → Coordinator for that baseline. */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const m = /^\/api\/repos\/([A-Za-z0-9][A-Za-z0-9._-]{0,62})(\/.*)$/.exec(url.pathname);
  if (!m?.[1] || !m[2]) return json({ error: "not found" }, 404);
  const baseline = m[1];
  const rest = m[2];
  const route = routes.find(([method, pattern]) => method === request.method && pattern.test(rest));
  if (!route) return json({ error: "not found" }, 404);
  const stub = env.COORDINATOR.getByName(baseline);
  try {
    await stub.ensure(baseline);
    return await route[2](stub, request, new URL(rest, url));
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    return json({ error: (err as Error).message }, 500);
  }
}

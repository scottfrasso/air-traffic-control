import { repoRef } from "../artifacts";
import { createPushSubscription } from "../subscriptions";
import type { Directory } from "./directory";
import type { Caller } from "./identity";
import type { RepoStore } from "./store";
import { CHECK_NAMES, type CheckName, type ResolutionKind } from "./types";

export interface ApiEnv {
  REPOS: DurableObjectNamespace<RepoStore>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ARTIFACTS: Env["ARTIFACTS"];
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  PUSH_QUEUE_ID?: string;
  ARTIFACTS_NAMESPACE?: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const KINDS: ResolutionKind[] = ["wrong", "intentional", "wontfix"];
/** People push with this; long enough for a working session, short enough to not live forever. */
const GIT_TOKEN_TTL_S = 8 * 3600;

async function body<T>(request: Request): Promise<T> {
  if (request.method === "GET" || request.method === "DELETE") return {} as T;
  const text = await request.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

type Ctx = { env: ApiEnv; person: Caller; request: Request; params: string[]; directory: DurableObjectStub<Directory> };
type Route = [method: string, pattern: RegExp, handler: (c: Ctx) => Promise<Response>];

const store = (c: Ctx) => c.env.REPOS.getByName(c.params[0]!);
const prId = (c: Ctx) => Number(c.params[1]);

/** Store errors that are the caller's fault, as HTTP statuses. */
function mapError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const m = (err as Error).message ?? String(err);
  if (/^no PR\d+|^no run /.test(m)) return new HttpError(404, m);
  if (/already has an open PR|is (merged|closed|draft)$|push first, or name the head/.test(m)) return new HttpError(409, m);
  if (/^unknown check /.test(m)) return new HttpError(400, m);
  if (/branch .* not found|can't merge .* into itself/.test(m)) return new HttpError(400, m);
  return new HttpError(500, m);
}

const routes: Route[] = [
  ["GET", /^\/api\/me$/, async (c) => json(c.person)],

  ["GET", /^\/api\/repos$/, async (c) => json({ repos: await c.directory.listRepos() })],
  [
    "POST",
    /^\/api\/repos$/,
    async (c) => {
      const { name } = await body<{ name?: unknown }>(c.request);
      if (typeof name !== "string" || !REPO_NAME.test(name)) throw new HttpError(400, "name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$");
      if (await c.directory.hasRepo(name)) throw new HttpError(409, `repo ${name} already exists`);
      let created: { remote?: string };
      try {
        created = (await c.env.ARTIFACTS.create(name, { setDefaultBranch: "main", description: `created by ${c.person.email}` })) as { remote?: string };
      } catch (err) {
        if (/ALREADY_EXISTS/.test((err as Error).message)) throw new HttpError(409, `repo ${name} already exists in Artifacts`);
        throw err;
      }
      // Push events for every branch (PR heads) arrive through this subscription; without the API token they can't.
      let subscription: string | null = null;
      if (c.env.CF_API_TOKEN) subscription = await createPushSubscription(c.env as unknown as Env, name).catch(() => null);
      await c.directory.addRepo(name, c.person.email, subscription);
      await c.env.REPOS.getByName(name).init(name);
      return json({ name, remote: created.remote ?? null, pushEvents: !!subscription }, 201);
    },
  ],
  [
    "POST",
    /^\/api\/repos\/([^/]+)\/git-credentials$/,
    async (c) => {
      const ref = await repoRef(c.env as unknown as Env, c.params[0]!, "write", GIT_TOKEN_TTL_S);
      const auth = `git -c http.extraHeader="Authorization: Bearer ${ref.token}"`;
      return json({
        remote: ref.remote, token: ref.token, expiresInSeconds: GIT_TOKEN_TTL_S,
        commands: { clone: `${auth} clone ${ref.remote}`, push: `${auth} push ${ref.remote} HEAD:<branch>`, fetch: `${auth} fetch ${ref.remote}` },
      });
    },
  ],

  [
    "GET",
    /^\/api\/prs$/,
    async (c) => {
      // The dashboard: every repo's PRs, newest activity first.
      const repos = await c.directory.listRepos();
      const all = await Promise.all(repos.map(async (r) => (await c.env.REPOS.getByName(r.name).listSummaries()).map((s) => ({ repo: r.name, ...s }))));
      return json({ prs: all.flat().sort((a, b) => b.updatedAt - a.updatedAt) });
    },
  ],
  ["GET", /^\/api\/repos\/([^/]+)\/prs$/, async (c) => {
    const state = new URL(c.request.url).searchParams.get("state");
    if (state && !["draft", "ready", "merged", "closed"].includes(state)) throw new HttpError(400, "state must be draft, ready, merged or closed");
    return json({ prs: await store(c).listPrs((state ?? undefined) as never) });
  }],
  [
    "POST",
    /^\/api\/repos\/([^/]+)\/prs$/,
    async (c) => {
      const b = await body<{ title?: unknown; source?: unknown; target?: unknown; intent?: unknown }>(c.request);
      if (typeof b.title !== "string" || !b.title.trim()) throw new HttpError(400, "title is required");
      if (typeof b.source !== "string" || !b.source) throw new HttpError(400, "source (the branch with the work) is required");
      if (b.target !== undefined && typeof b.target !== "string") throw new HttpError(400, "target must be a branch name");
      const intent = b.intent && typeof b.intent === "object" ? (b.intent as Record<string, string>) : undefined;
      // The author is whoever calls, never a field in the body.
      return json(await store(c).openPr({ title: b.title.trim(), author: c.person.email, source: b.source, ...(b.target ? { target: b.target as string } : {}), ...(intent ? { intent } : {}) }), 201);
    },
  ],
  ["GET", /^\/api\/repos\/([^/]+)\/prs\/(\d+)$/, async (c) => json(await store(c).getPr(prId(c)))],
  ["GET", /^\/api\/repos\/([^/]+)\/prs\/(\d+)\/diff$/, async (c) => json(await store(c).getDiff(prId(c)))],
  [
    "POST",
    /^\/api\/repos\/([^/]+)\/prs\/(\d+)\/checks$/,
    async (c) => {
      // What an agent calls when its work is done: the gauntlet on the head (or the named commit), or single checks.
      const b = await body<{ sha?: unknown; only?: unknown }>(c.request);
      if (b.sha !== undefined && typeof b.sha !== "string") throw new HttpError(400, "sha must be a commit");
      if (b.only !== undefined && (!Array.isArray(b.only) || b.only.some((x) => !CHECK_NAMES.includes(x as CheckName))))
        throw new HttpError(400, `only must be a list of: ${CHECK_NAMES.join(", ")}`);
      return json(await store(c).runChecks(prId(c), c.person.email, { ...(b.sha ? { sha: b.sha as string } : {}), ...(b.only ? { only: b.only as CheckName[] } : {}) }));
    },
  ],
  ["POST", /^\/api\/repos\/([^/]+)\/prs\/(\d+)\/ready$/, async (c) => json(await store(c).markReady(prId(c), c.person.email))],
  ["POST", /^\/api\/repos\/([^/]+)\/prs\/(\d+)\/draft$/, async (c) => (await store(c).markDraft(prId(c), c.person.email), json({ ok: true }))],
  ["POST", /^\/api\/repos\/([^/]+)\/prs\/(\d+)\/close$/, async (c) => (await store(c).closePr(prId(c), c.person.email), json({ ok: true }))],
  [
    "POST",
    /^\/api\/repos\/([^/]+)\/prs\/(\d+)\/approve$/,
    async (c) => {
      const { sha } = await body<{ sha?: unknown }>(c.request);
      if (typeof sha !== "string" || !sha) throw new HttpError(400, "sha (the commit you reviewed) is required");
      const r = await store(c).approve(prId(c), c.person.email, sha, c.person.via);
      return r.ok ? json(r) : json({ error: r.error }, c.person.via === "access" ? 409 : 403);
    },
  ],
  [
    "POST",
    /^\/api\/repos\/([^/]+)\/prs\/(\d+)\/findings\/(\d+)\/resolve$/,
    async (c) => {
      const b = await body<{ kind?: unknown; reason?: unknown }>(c.request);
      if (!KINDS.includes(b.kind as ResolutionKind)) throw new HttpError(400, "kind must be wrong, intentional or wontfix");
      if (typeof b.reason !== "string" || !b.reason.trim()) throw new HttpError(400, "reason is required");
      const r = await store(c).resolveFinding(prId(c), Number(c.params[2]), c.person.email, b.kind as ResolutionKind, b.reason, c.person.via);
      return r.ok ? json(r) : json({ error: r.error }, 409);
    },
  ],
  [
    "POST",
    /^\/api\/repos\/([^/]+)\/prs\/(\d+)\/merge$/,
    async (c) => {
      const r = await store(c).merge(prId(c), c.person.email);
      return r.ok ? json(r) : json({ error: "not mergeable", blockers: r.blockers }, 409);
    },
  ],

  ["GET", /^\/api\/tokens$/, async (c) => json({ tokens: await c.directory.listTokens(c.person.email) })],
  [
    "POST",
    /^\/api\/tokens$/,
    async (c) => {
      const { label } = await body<{ label?: unknown }>(c.request);
      return json(await c.directory.createToken(c.person.email, typeof label === "string" ? label : "token"), 201);
    },
  ],
  ["DELETE", /^\/api\/tokens\/(\d+)$/, async (c) => (await c.directory.revokeToken(c.person.email, Number(c.params[0])), json({ ok: true }))],
];

/** The method and path of every route (the web UI's test checks its calls against this). */
export const ROUTE_TABLE = routes.map(([method, pattern]) => ({ method, pattern }));

/** `/api/...` for a known person. Repo routes 404 for repos that aren't registered here. */
export async function handleApi(request: Request, env: ApiEnv, person: Caller, directory: DurableObjectStub<Directory>): Promise<Response> {
  const path = new URL(request.url).pathname;
  for (const [method, pattern, handler] of routes) {
    const m = pattern.exec(path);
    if (!m || method !== request.method) continue;
    const params = m.slice(1).map(decodeURIComponent);
    try {
      if (path.startsWith("/api/repos/") && params[0] && !(await directory.hasRepo(params[0]))) throw new HttpError(404, `no repo ${params[0]}`);
      return await handler({ env, person, request, params, directory });
    } catch (err) {
      const e = mapError(err);
      return json({ error: e.message, ...e.extra }, e.status);
    }
  }
  return json({ error: "not found" }, 404);
}

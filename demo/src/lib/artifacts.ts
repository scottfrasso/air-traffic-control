import { config } from "./env.ts";

/** Minimal Artifacts REST client (setup/teardown only; agents never hold a Cloudflare API token). */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/artifacts/namespaces/${config.namespace}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.cfToken()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; errors: Array<{ code: number; message: string }>; result: T };
  if (!json.success) throw new Error(`Artifacts ${method} ${path}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

export const artifacts = {
  create: (name: string, description: string) =>
    call<{ name: string; remote: string; token: string; default_branch: string }>("POST", "/repos", { name, description, default_branch: "main" }),
  delete: (name: string) => call<unknown>("DELETE", `/repos/${name}`),
  list: (search?: string) =>
    call<Array<{ name: string; created_at: string }>>("GET", `/repos?limit=200${search ? `&search=${encodeURIComponent(search)}` : ""}`),
};

/** Event subscriptions (account-level REST) — only those this project created (name prefix "agentmesh "). */
export async function listOurSubscriptions(): Promise<Array<{ id: string; name: string; repo: string | null }>> {
  const out: Array<{ id: string; name: string; repo: string | null }> = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/event_subscriptions/subscriptions?per_page=50&page=${page}`, {
      headers: { authorization: `Bearer ${config.cfToken()}` },
    });
    const json = (await res.json()) as { result: Array<{ id: string; name: string; source: { repo_name?: string } }> | null };
    const rows = json.result ?? [];
    out.push(...rows.filter((r) => r.name.startsWith("agentmesh ")).map((r) => ({ id: r.id, name: r.name, repo: r.source.repo_name ?? null })));
    if (rows.length < 50) return out;
  }
}

export async function deleteSubscription(id: string) {
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/event_subscriptions/subscriptions/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${config.cfToken()}` },
  });
}

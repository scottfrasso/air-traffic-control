/**
 * Per-repo Artifacts `pushed` subscriptions → our queue (ADR-0002). There is no namespace-wide
 * push source (verified: the API requires `source.repo_name`), so each fork gets its own.
 */
const api = (env: Env, path: string) => `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/event_subscriptions/subscriptions${path}`;

export async function createPushSubscription(env: Env, repo: string): Promise<string> {
  const res = await fetch(api(env, ""), {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: `agentmesh ${repo}`,
      enabled: true,
      source: { type: "artifacts.repo", namespace: env.ARTIFACTS_NAMESPACE, repo_name: repo },
      destination: { type: "queues.queue", queue_id: env.PUSH_QUEUE_ID },
      events: ["pushed"],
    }),
  });
  const body = (await res.json()) as { success: boolean; errors: unknown[]; result: { id: string } | null };
  if (!body.success || !body.result) throw new Error(`subscription create failed: ${JSON.stringify(body.errors)}`);
  return body.result.id;
}

export async function deletePushSubscription(env: Env, id: string): Promise<void> {
  await fetch(api(env, `/${id}`), { method: "DELETE", headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } });
}

import { createPushSubscription } from "./subscriptions";
import type { ForkCredentials } from "./types";

/**
 * Fork for an agent, then subscribe the fork to push events (ADR-0002). Kept outside the Coordinator so the
 * DO stays free of Cloudflare API calls; the DO just records the subscription id.
 */
export async function startFork(env: Env, baseline: string, agent: string): Promise<ForkCredentials> {
  const stub = env.COORDINATOR.getByName(baseline);
  await stub.ensure(baseline);
  const creds = await stub.createFork(agent);
  try {
    await stub.attachSubscription(creds.fork, await createPushSubscription(env, creds.fork));
  } catch (err) {
    await stub.attachSubscription(creds.fork, null, (err as Error).message);
  }
  return creds;
}

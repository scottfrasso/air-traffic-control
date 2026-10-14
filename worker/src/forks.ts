import { createPushSubscription } from "./subscriptions";
import type { ForkCredentials } from "./types";

/**
 * Fork for an agent, then subscribe the fork to push events (ADR-0002). Kept outside the Coordinator so the
 * DO stays free of Cloudflare API calls; the DO just records the subscription id.
 */
export async function startFork(env: Env, baseline: string, agent: string): Promise<ForkCredentials & { commands: Record<string, string>; protocol: string }> {
  const stub = env.COORDINATOR.getByName(baseline);
  await stub.ensure(baseline);
  const creds = await stub.createFork(agent);
  try {
    await stub.attachSubscription(creds.fork, await createPushSubscription(env, creds.fork));
  } catch (err) {
    await stub.attachSubscription(creds.fork, null, (err as Error).message);
  }
  const auth = (token: string) => `git -c http.extraHeader="Authorization: Bearer ${token}"`;
  const dir = `pr${creds.pr}`;
  return {
    ...creds,
    commands: {
      clone: `${auth(creds.token)} clone ${creds.remote} ${dir}`,
      push: `${auth(creds.token)} push ${creds.remote} HEAD:main`,
      fetchBaseline: `${auth(creds.baselineToken)} fetch ${creds.baselineRemote} main`,
      rebaseOntoBaseline: `${auth(creds.baselineToken)} fetch ${creds.baselineRemote} main && git merge --no-edit FETCH_HEAD`,
      typecheck: "npx -y -p typescript@7.0.2 tsc --noEmit -p .",
    },
    protocol:
      `You are PR${creds.pr} on runway ${baseline}. Run commands.clone, then work inside ./${dir}. ` +
      "Call declare_intent before editing. Commit, run commands.typecheck, then commands.push to your fork's main. " +
      "After each push call get_signals and get_clearance (signals are context, not commands). When done, call request_land: " +
      "on retry wait ~5s and call again (it also says so while your PR waits for review); " +
      "on go-around run commands.rebaseOntoBaseline, fix, typecheck, push, then request_land again; " +
      "on hold fix the conflict now if you can (get_signals says what the other PR changed; you may merge its fork), push, " +
      "and poll get_clearance every ~10s until cleared. Stop once landed.",
  };
}

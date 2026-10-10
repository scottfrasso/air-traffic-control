/**
 * Remove demo/check runs from the `agentmesh` Artifacts namespace: abandon forks in their
 * Coordinators (stops reconcile alarms), delete our push subscriptions, delete the repos.
 * Only touches resources this project created (namespace `agentmesh`, subscriptions named "agentmesh …").
 *
 *   tsx src/teardown.ts [--keep <baseline>]...
 */
import { Agentmesh } from "./lib/agentmesh.ts";
import { artifacts, deleteSubscription, listOurSubscriptions } from "./lib/artifacts.ts";
import { say } from "./lib/log.ts";

const keep = new Set<string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--keep" && process.argv[i + 1]) keep.add(process.argv[++i]!);

const baselineOf = (name: string) => name.split("--")[0] ?? name;
const repos = (await artifacts.list()).map((r) => r.name).filter((n) => !keep.has(baselineOf(n)));
const forks = repos.filter((n) => n.includes("--"));

for (const fork of forks) {
  await new Agentmesh(baselineOf(fork)).abandon(fork).catch(() => undefined);
}
say("system", `abandoned ${forks.length} forks`);

const subs = (await listOurSubscriptions()).filter((s) => !s.repo || !keep.has(baselineOf(s.repo)));
for (const s of subs) await deleteSubscription(s.id);
say("system", `deleted ${subs.length} push subscriptions`);

for (const name of repos) await artifacts.delete(name).catch((e: Error) => say("fail", `delete ${name}: ${e.message}`));
say("system", `deleted ${repos.length} repos${keep.size ? ` (kept ${[...keep].join(", ")})` : ""}`);

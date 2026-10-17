/**
 * Create or update the review agents as Claude Managed Agents (spec: "Agent definitions"):
 *   pnpm setup:agents [--dry-run]
 *
 * Needs ANTHROPIC_API_KEY (repo-root .env or the environment). Idempotent: agents and the sandbox environment are
 * found by name and reused; an agent whose instructions changed gets a new version. Writes the ids into
 * worker/wrangler.jsonc (vars AGENT_IDS, AGENT_ENVIRONMENT_ID: not secrets) so the next deploy picks them up.
 * The key itself goes to the Worker with: cd worker && pnpm exec wrangler secret put ANTHROPIC_API_KEY
 * The key is never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUTPUT, SYSTEM } from "../../worker/src/review/agents/prompts.ts";
import type { Role } from "../../worker/src/review/agents/client.ts";
import { readDotenv, ROOT } from "./lib/env.ts";

const ROLES: Role[] = ["classifier", "correctness", "security", "tests", "verifier"];
const BASE = "https://api.anthropic.com";
const BETA = "managed-agents-2026-04-01";

export interface AgentSpec {
  role: Role;
  name: string;
  model: string;
  system: string;
  tools: Array<{ type: string }>;
}

/** The five agents. Triage runs on Haiku; reviewing and verifying on Sonnet (cost: Opus is not worth it on small changes yet). */
export function agentPlan(): AgentSpec[] {
  return ROLES.map((role) => ({
    role,
    name: `atc-${role}`,
    model: role === "classifier" ? "claude-haiku-5-5" : "claude-sonnet-5-5",
    system: `${SYSTEM[role]}\n\nWrite exactly one file: /mnt/session/outputs/${OUTPUT[role]}. Then stop.`,
    tools: [{ type: "agent_toolset_20260401" }],
  }));
}

/** One sandbox environment for every session: package registries only, so tests can install; no repo host. */
export const ENVIRONMENT = {
  name: "atc-review",
  config: { type: "cloud", networking: { type: "limited", allowed_hosts: [] as string[], allow_package_managers: true } },
};

const envFile = () => process.env.ATC_ENV_FILE ?? resolve(ROOT, ".env");
const dotenv = () => readDotenv(envFile());

async function call<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": BETA, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** wrangler.jsonc with AGENT_IDS (a JSON string holding JSON, so escaped quotes) and AGENT_ENVIRONMENT_ID set. */
export function withAgentVars(text: string, ids: Record<Role, string>, environmentId: string): string {
  const str = String.raw`"(?:[^"\\]|\\.)*"`; // a JSON string literal, escapes included
  return text
    .replace(new RegExp(String.raw`"AGENT_IDS":\s*` + str), () => `"AGENT_IDS": ${JSON.stringify(JSON.stringify(ids))}`)
    .replace(new RegExp(String.raw`"AGENT_ENVIRONMENT_ID":\s*` + str), () => `"AGENT_ENVIRONMENT_ID": ${JSON.stringify(environmentId)}`);
}

export type Listed = { id: string; name: string; system?: string; model?: string | { id: string } };

/** The API lists `model` as an object ({ id, effort, speed }); compare by id, so an unchanged agent isn't re-versioned. */
export function needsUpdate(found: Listed, spec: AgentSpec): boolean {
  const model = typeof found.model === "string" ? found.model : found.model?.id;
  return found.system !== spec.system || model !== spec.model;
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const plan = agentPlan();
  if (dry) {
    console.log("Dry run: nothing is created or changed.");
    for (const a of plan) console.log(`  agent ${a.name} (${a.model}): writes ${OUTPUT[a.role]}`);
    console.log(`  environment ${ENVIRONMENT.name}: networking limited to package registries`);
    console.log("  then: AGENT_IDS and AGENT_ENVIRONMENT_ID into worker/wrangler.jsonc");
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY ?? dotenv().ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set (repo-root .env or the environment)");

  const existing = (await call<{ data: Listed[] }>(key, "GET", "/v1/agents?limit=100")).data;
  const ids = {} as Record<Role, string>;
  for (const a of plan) {
    const found = existing.find((e) => e.name === a.name);
    const body = { name: a.name, model: a.model, system: a.system, tools: a.tools };
    if (!found) {
      ids[a.role] = (await call<{ id: string }>(key, "POST", "/v1/agents", body)).id;
      console.log(`created ${a.name}`);
    } else if (needsUpdate(found, a)) {
      ids[a.role] = (await call<{ id: string }>(key, "POST", `/v1/agents/${found.id}`, body)).id;
      console.log(`updated ${a.name} (new version)`);
    } else {
      ids[a.role] = found.id;
      console.log(`unchanged ${a.name}`);
    }
  }
  const envs = (await call<{ data: Array<{ id: string; name: string }> }>(key, "GET", "/v1/environments?limit=100")).data;
  const environmentId = envs.find((e) => e.name === ENVIRONMENT.name)?.id ?? (await call<{ id: string }>(key, "POST", "/v1/environments", ENVIRONMENT)).id;
  console.log(`environment ${ENVIRONMENT.name}: ${environmentId}`);

  const wranglerPath = resolve(ROOT, "worker/wrangler.jsonc");
  writeFileSync(wranglerPath, withAgentVars(readFileSync(wranglerPath, "utf8"), ids, environmentId));
  console.log("wrote AGENT_IDS and AGENT_ENVIRONMENT_ID into worker/wrangler.jsonc");
  console.log("next: cd worker && pnpm exec wrangler secret put ANTHROPIC_API_KEY, then deploy");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

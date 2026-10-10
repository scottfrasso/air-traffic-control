import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Load KEY=VALUE pairs from the repo-root .env without printing anything. */
function loadDotenv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(resolve(ROOT, ".env"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
    );
  } catch {
    return {};
  }
}

const dotenv = loadDotenv();

export function need(name: string): string {
  const v = process.env[name] ?? dotenv[name];
  if (!v) throw new Error(`${name} is not set (env or .env)`);
  return v;
}

export const config = {
  workerUrl: process.env.AGENTMESH_URL ?? dotenv.AGENTMESH_URL ?? "https://agentmesh.scottfrasso.workers.dev",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? dotenv.CLOUDFLARE_ACCOUNT_ID ?? "cd5005b633a7bdac0f47d9f93c3ad45c",
  namespace: "agentmesh",
  apiKey: () => need("AGENTMESH_API_KEY"),
  cfToken: () => need("CLOUDFLARE_API_TOKEN"),
};

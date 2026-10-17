import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** KEY=VALUE pairs from a .env file (the repo root's by default), without printing anything; {} if it's missing. */
export function readDotenv(path = resolve(ROOT, ".env")): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
    );
  } catch {
    return {};
  }
}

const dotenv = readDotenv();

export function need(name: string): string {
  const v = process.env[name] ?? dotenv[name];
  if (!v) throw new Error(`${name} is not set (env or .env)`);
  return v;
}

export const config = {
  workerUrl: process.env.AGENTMESH_URL ?? dotenv.AGENTMESH_URL ?? "https://agentmesh-review.scottfrasso.workers.dev",
};

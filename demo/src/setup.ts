/**
 * One-command deploy (issue #18): `pnpm setup:cloudflare [--dry-run]` from the repo root.
 *
 * Reads the repo-root .env, then, idempotently:
 *   1. finds the account (CLOUDFLARE_ACCOUNT_ID, or the token's only account)
 *   2. creates the queues agentmesh-review-push-events and agentmesh-review-push-events-dlq if missing
 *   3. creates the Artifacts namespace agentmesh if missing
 *   4. writes CF_ACCOUNT_ID and PUSH_QUEUE_ID into worker/wrangler.jsonc
 *   5. deploys the Worker with its secrets (CF_API_TOKEN, and ANTHROPIC_API_KEY if .env has it) via `wrangler deploy --secrets-file`
 *   6. writes AGENTMESH_URL and CLOUDFLARE_ACCOUNT_ID into .env, so `pnpm e2e:review` targets this deployment
 * Then: `pnpm setup:agents` (the review agents), Cloudflare Access in front of the Worker, a personal token in the UI.
 * Every resource it touches is named agentmesh*. Secrets are never printed.
 */
import { spawn } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "./lib/env.ts";

// API tokens are often IP-filtered on IPv4 only; prefer it (same as NODE_OPTIONS=--dns-result-order=ipv4first elsewhere).
setDefaultResultOrder("ipv4first");
const DRY = process.argv.includes("--dry-run");
const ENV_FILE = resolve(ROOT, ".env");
const WRANGLER = resolve(ROOT, "worker/wrangler.jsonc");
const QUEUES = ["agentmesh-review-push-events", "agentmesh-review-push-events-dlq"];
const NAMESPACE = "agentmesh";

const readEnv = (): Record<string, string> => {
  try {
    return Object.fromEntries(
      readFileSync(ENV_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
    );
  } catch {
    return {};
  }
};
const env = { ...readEnv(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLOUDFLARE_|AGENTMESH_)/.test(k))) } as Record<string, string | undefined>;
const say = (msg: string) => console.log(`${DRY ? "[dry run] " : ""}${msg}`);

/**
 * Add KEY=value to .env unless it is already set there. `respectShell`: also skip when the shell has it (for the API
 * key; non-secret values are still written so a later shell without them works).
 */
function setEnv(key: string, value: string, secret = false, respectShell = false) {
  if (readEnv()[key] || (respectShell && process.env[key])) return;
  say(`.env: set ${key}${secret ? " (generated, not shown)" : `=${value}`}`);
  if (!DRY) appendFileSync(ENV_FILE, `\n${key}=${value}\n`);
}

// Checked in main(), not at import: tests import withVars from here without any credentials (review of #39).
const token = env.CLOUDFLARE_API_TOKEN ?? "";

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; errors?: Array<{ code: number; message: string }>; result: T };
  if (!json.success) {
    const errs = JSON.stringify(json.errors ?? []);
    if (errs.includes("9109")) throw new Error(`${method} ${path}: the API token can't be used from this IP (error 9109). Allow this IP on the token.`);
    throw new Error(`${method} ${path}: ${errs}`);
  }
  return json.result;
}

async function account(): Promise<string> {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = await cf<Array<{ id: string; name: string }>>("GET", "/accounts");
  if (accounts.length !== 1) throw new Error(`the token sees ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID in .env`);
  return accounts[0]!.id;
}

async function ensureQueue(acct: string, name: string): Promise<string> {
  // Filter by name (as wrangler does): a plain list is paged, so on a busy account the queue could be missed.
  const all = await cf<Array<{ queue_id: string; queue_name: string }>>("GET", `/accounts/${acct}/queues?name=${encodeURIComponent(name)}`);
  const found = all.find((q) => q.queue_name === name);
  if (found) {
    say(`queue ${name}: exists (${found.queue_id})`);
    return found.queue_id;
  }
  if (DRY) {
    say(`queue ${name}: would create`);
    return "<new-queue-id>";
  }
  const made = await cf<{ queue_id: string }>("POST", `/accounts/${acct}/queues`, { queue_name: name });
  say(`queue ${name}: created (${made.queue_id})`);
  return made.queue_id;
}

async function ensureNamespace(acct: string) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/artifacts/namespaces/${NAMESPACE}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.ok) return say(`Artifacts namespace ${NAMESPACE}: exists`);
  if (DRY) return say(`Artifacts namespace ${NAMESPACE}: would create`);
  await cf("POST", `/accounts/${acct}/artifacts/namespaces`, { namespace: NAMESPACE });
  say(`Artifacts namespace ${NAMESPACE}: created`);
}

/** Point wrangler.jsonc's vars at this account and queue. */
export function withVars(jsonc: string, vars: Record<string, string>): string {
  let out = jsonc;
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`);
    if (!re.test(out)) throw new Error(`wrangler.jsonc has no "${k}" var`);
    out = out.replace(re, `$1"${v}"`);
  }
  return out;
}

async function main() {
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set in .env (needs Workers, Queues, Artifacts and Containers edit)");
  const acct = await account();
  say(`account ${acct}`);
  const [queueId] = [await ensureQueue(acct, QUEUES[0]!), await ensureQueue(acct, QUEUES[1]!)];
  await ensureNamespace(acct);

  const before = readFileSync(WRANGLER, "utf8");
  const after = withVars(before, { CF_ACCOUNT_ID: acct, PUSH_QUEUE_ID: queueId! });
  if (after !== before) {
    say(`worker/wrangler.jsonc: CF_ACCOUNT_ID=${acct}, PUSH_QUEUE_ID=${queueId}`);
    if (!DRY) writeFileSync(WRANGLER, after);
  } else say("worker/wrangler.jsonc: already points at this account and queue");

  setEnv("CLOUDFLARE_ACCOUNT_ID", acct);
  // Managed Agents for the review pipeline. Optional: without it every agent step is errored and a human must approve.
  const anthropicKey = process.env.ANTHROPIC_API_KEY || readEnv().ANTHROPIC_API_KEY || "";
  if (!anthropicKey) say("note: ANTHROPIC_API_KEY not set: CI runs, but every agent review is errored (a person must approve) until it is.");
  // The Worker's own token only creates per-fork push subscriptions (ADR-0002); a narrower one is better.
  const workerToken = env.CLOUDFLARE_AGENTMESH_WORKER_API_KEY ?? token;
  if (!env.CLOUDFLARE_AGENTMESH_WORKER_API_KEY)
    say(
      "note: CLOUDFLARE_AGENTMESH_WORKER_API_KEY not set, so the Worker gets CLOUDFLARE_API_TOKEN. That works only if the token " +
        "is NOT IP-restricted (the Worker calls the API from Cloudflare's network). Better: a separate token with Queues edit only.",
    );

  if (DRY) {
    say(`would run: wrangler deploy --secrets-file <CF_API_TOKEN${anthropicKey ? ", ANTHROPIC_API_KEY" : ""}> (needs Docker for the checker image)`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "agentmesh-setup-"));
  const secrets = join(dir, "secrets.json");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    writeFileSync(secrets, JSON.stringify({ CF_API_TOKEN: workerToken, ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}) }), { mode: 0o600 });
    say("deploying (building the checker image with Docker can take a few minutes)...");
    // Async, so the event loop stays free: a signal reaches our handler (which passes it on to wrangler) instead of
    // waiting behind a blocking spawn, and `finally` always removes the secrets file (reviews of #39 and #41).
    const child = spawn("pnpm", ["exec", "wrangler", "deploy", "--secrets-file", secrets], {
      cwd: resolve(ROOT, "worker"),
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: acct, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv4first`.trim() },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let interrupted: NodeJS.Signals | null = null;
    const forward = (sig: NodeJS.Signals) => {
      interrupted = sig;
      child.kill(sig);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward); // the terminal closed: still stop wrangler and remove the secrets
    let out = "";
    const ignore = () => undefined; // a closed terminal (EIO) must not crash us before `finally` removes the secrets
    process.stdout.on("error", ignore);
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk); // live progress
      out += chunk.toString("utf8");
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((done) => {
      child.on("error", (error) => done({ code: null, signal: null, error }));
      child.on("close", (code, signal) => done({ code, signal }));
    });
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
    process.stdout.off("error", ignore);
    if (exit.error) throw new Error(`couldn't run wrangler: ${exit.error.message}`);
    const sig = exit.code === 0 ? null : (interrupted ?? exit.signal); // finished anyway: report the deploy, not the signal
    if (sig) {
      say(`deploy interrupted (${sig})`);
      process.exitCode = sig === "SIGINT" ? 130 : sig === "SIGHUP" ? 129 : 143;
      return;
    }
    if (exit.code !== 0) throw new Error(`wrangler deploy failed (exit ${exit.code})`);
    const url = /https:\/\/agentmesh-review\.[a-z0-9-]+\.workers\.dev/.exec(out)?.[0];
    if (url) setEnv("AGENTMESH_URL", url);
    const target = process.env.AGENTMESH_URL || readEnv().AGENTMESH_URL; // what pnpm e2e:review will use
    if (!url || target !== url)
      say(`warning: AGENTMESH_URL (shell or .env) is ${target ?? "unset"}${url ? `, but this deploy is ${url}` : " and the deploy URL wasn't found"}. Set it to your Worker's URL before pnpm e2e:review.`);
    say(`deployed${url ? `: ${url}` : ""}. Next: pnpm setup:agents, put Cloudflare Access in front of it, create a personal token in the UI (REVIEW_TOKEN in .env), then pnpm e2e:review`);
  } finally {
    cleanup();
  }
}

if (process.argv[1]?.endsWith("setup.ts")) await main();

# Cloudflare API cheat sheet (verified 2026-10-10)

Checked against developers.cloudflare.com (pages last updated Jul to Oct 2026), the npm registry, and the
published `wrangler@4.149.0` tarball. Anything I could not confirm is marked **UNCERTAIN**.

## 0. Versions and the big changes

| Package | Latest on npm | Notes |
| --- | --- | --- |
| `wrangler` | 4.149.0 | Supports `exports`, container `images`, and `artifacts.repo` subscriptions |
| `@cloudflare/workers-types` | 5.20261010.1 | Prefer `wrangler types` (generates `worker-configuration.d.ts`) |
| `@cloudflare/sandbox` | **1.0.0** (released 2026-09-30) | **Breaking rewrite.** 0.x line ends at 0.12.10 |
| `agents` | 0.28.0 | Peer deps are pinned **exactly**: `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/client@2.0.0`, `@modelcontextprotocol/sdk@1.30.0` |
| `@modelcontextprotocol/server` | 2.3.1 | **Install 2.0.0** to match `agents@0.28.0` |
| `@modelcontextprotocol/client` | 2.3.1 | 2.0.0 matches agents. A standalone Node script can use either version |
| `@modelcontextprotocol/sdk` | 1.32.1 | v1 (legacy). Only needed for `McpAgent`. agents wants 1.30.0 |
| `zod` | 4.6.5 | agents peer: `^4.0.0`. MCP server v2 depends on `^4.2.0` |
| `typescript` | 7.0.2 | |

What changed since older training data:

1. **Durable Object `migrations` is now "legacy".** New Workers declare classes in a top-level `exports` map
   (`{"type":"durable-object","storage":"sqlite"}`). Both flows still work, but **a Worker can use only one of them**.
   `new_sqlite_classes` still works under `migrations`.
2. **Sandbox SDK 1.0 removed the `Sandbox` class.** That means no `getSandbox()`, `sandbox.exec()`, `gitCheckout()`,
   `setEnvVars()`, `{success}` result, or `cloudflare/sandbox` base image to build on. You write a plain
   `DurableObject` and call `this.ctx.container.start()` and `.exec()` (a native Workers API). The package now only
   provides helper classes (`Files`, `S3Mount`, `DirectoryBackup`).
3. **`McpAgent` is deprecated and feature-frozen** (since agents 0.20.0). The recommended path is the stateless
   `createMcpHandler` from `agents/mcp/server` with MCP SDK **v2** (`@modelcontextprotocol/server`). It needs no
   Durable Object.
4. Workflows can also be declared in `exports` (`"type":"workflow"`, Wrangler 4.139.0 or later). The classic
   `workflows` binding still works.

---

## 1. Durable Objects (SQLite): the coordinator

Sources: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ ,
https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ,
https://developers.cloudflare.com/durable-objects/api/state/ ,
https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/

### wrangler.jsonc (current `exports` flow)
```jsonc
{
  "compatibility_date": "2026-10-10",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "COORDINATOR", "class_name": "Coordinator" }]
  },
  "exports": {
    "Coordinator": { "type": "durable-object", "storage": "sqlite" }
  }
}
```
Legacy alternative. You cannot mix it with `exports` in the same Worker:
```jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Coordinator"] }]
```
Rules: a class in code but not in `exports` is **not** provisioned. Lifecycle changes apply only through
`wrangler deploy`; `versions upload` fails when `exports` is present. To delete or rename a class, set
`"state": "deleted"` or `"state": "renamed"` plus `renamed_to`.

### SQL, RPC, and blockConcurrencyWhile
```ts
import { DurableObject } from "cloudflare:workers";

export class Coordinator extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Run schema setup before any request is delivered (30 s timeout; if it throws, the DO is reset)
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS pushes(
        id TEXT PRIMARY KEY, repo TEXT, sha TEXT, status TEXT, created_at INTEGER)`);
    });
  }

  // RPC method: any public async method can be called from a stub
  async recordPush(id: string, repo: string, sha: string) {
    this.sql.exec("INSERT INTO pushes VALUES (?, ?, ?, 'pending', ?)", id, repo, sha, Date.now());
  }
  async getPush(id: string) {
    return this.sql.exec("SELECT * FROM pushes WHERE id = ?", id).one(); // throws unless exactly 1 row
  }
  async list() {
    return this.sql.exec("SELECT * FROM pushes ORDER BY created_at DESC").toArray();
  }
}

// Caller (Worker, Workflow, or another DO):
const stub = env.COORDINATOR.getByName("global");
await stub.recordPush(id, repo, sha);
```
Cursor (`SqlStorageCursor`) API: `toArray()`, `one()` (throws on 0 or more than 1 rows), `next()`, `raw()` (rows
as arrays), `columnNames`, `rowsRead`, `rowsWritten`. Cursors are iterable.
- **Consume a cursor before the next `await`.** There is no snapshot isolation across awaits.
- `exec` cannot run `BEGIN` or `SAVEPOINT`. Use `ctx.storage.transactionSync(() => ...)` or `transaction()`.
- Multiple statements in one `exec` are allowed. Bindings apply to the last statement only.
- Limits: 10 GB per DO, 2 MB per row, 100 KB per statement, 100 bound params, 100 columns.
- You rarely need `blockConcurrencyWhile` outside the constructor, because SQL calls are synchronous.

### WebSocket hibernation (live dashboard push)
```ts
export class Coordinator extends DurableObject<Env> {
  async fetch(request: Request) {               // Worker forwards with: stub.fetch(request)
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["dashboard"]); // hibernatable (do NOT call server.accept())
    server.serializeAttachment({ id: crypto.randomUUID() }); // survives hibernation
    return new Response(null, { status: 101, webSocket: client });
  }
  broadcast(msg: unknown) {                     // call this after a state change
    for (const ws of this.ctx.getWebSockets("dashboard")) ws.send(JSON.stringify(msg));
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {}
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    ws.close(code, reason); // optional with compat date >= 2026-04-07 (auto-reply to Close)
  }
}
```
Optionally call `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))` in the constructor.
This answers pings without waking the DO. In-memory state is lost on hibernation, so rebuild it in the constructor
from `ctx.getWebSockets()` and `ws.deserializeAttachment()`.

---

## 2. Workflows: per-push checks

Sources: https://developers.cloudflare.com/workflows/build/workers-api/ ,
https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ ,
https://developers.cloudflare.com/workflows/reference/limits/ ,
https://developers.cloudflare.com/workflows/build/rules-of-workflows/

### wrangler.jsonc
```jsonc
"workflows": [
  { "name": "push-checks", "binding": "PUSH_CHECKS", "class_name": "PushChecksWorkflow" }
]
```
Optional fields: `"limits": {"steps": 25000}` and `"default_retention": {"success_retention":"3 days","error_retention":"7 days"}`.
Alternative (Wrangler 4.139.0 or later): `"exports": {"PushChecksWorkflow": {"type":"workflow","name":"push-checks"}}`.
Then call it through `ctx.exports.PushChecksWorkflow.create(...)` (local dev needs 4.142.0 or later).

### Code
```ts
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

type Params = { repo: string; sha: string; pushId: string };

export class PushChecksWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { repo, sha, pushId } = event.payload;

    // Call the coordinator DO through RPC inside a step (steps may retry, so keep them idempotent)
    await step.do("mark running", async () => {
      await this.env.COORDINATOR.getByName("global").setStatus(pushId, "running");
    });

    // Call the sandbox DO (see section 3). The RPC call keeps the container DO active while awaited
    const result = await step.do(
      "typecheck",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
      async () => this.env.SANDBOX.getByName(pushId).typecheck(repo, sha), // return value must be <= 1 MiB and serializable
    );

    await step.sleep("cooldown", "5 seconds"); // ms number or a duration string; sleeps do not count as steps
    return result;
  }
}

// Trigger it from the queue consumer or the fetch handler:
const instance = await env.PUSH_CHECKS.create({ id: `push-${pushId}`, params: { repo, sha, pushId } });
```
- Default step config: `{ retries: { limit: 5, delay: 10000, backoff: "exponential" }, timeout: "10 minutes" }`.
  Backoff can be `constant`, `linear`, or `exponential`. `delay` can also be a function `({ctx, error}) => duration`.
- `throw new NonRetryableError(msg)` stops retries. The import is `cloudflare:workflows`, confirmed in
  `@cloudflare/workers-types@5.20261010.1`.
- `create()` throws if the `id` already exists within retention. IDs are at most 100 chars and must match
  `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. Queue redeliveries reuse the same id, so catch the duplicate error.
- `step.do` callback receives `ctx` with `{ step: {name, count}, attempt, config }`.
- Other APIs: `step.sleepUntil`, `step.waitForEvent(name, {type, timeout})` (default timeout 24 h), and
  `instance.status()`, `env.X.get(id)`, `createBatch` (max 100).

**Limits that matter (Paid):** 30 s CPU per step by default (configurable up to 5 min). Wall clock per step is
unlimited. Step result is at most 1 MiB (unless you return a `ReadableStream`). Event payload is at most 1 MiB.
Instance state is at most 1 GB. 10,000 steps by default (up to 25,000). 50,000 concurrent instances. Creation rate is
100/s per workflow. Retention is 30 days. Docs advise keeping step timeouts at 30 minutes or less. Free plan: 10 ms
CPU per step and 1,024 steps.

---

## 3. Sandbox SDK 1.0 / Containers: `git clone` + `git merge` + `tsc --noEmit`

Sources: https://developers.cloudflare.com/sandbox/reference/ , https://developers.cloudflare.com/sandbox/get-started/ ,
https://developers.cloudflare.com/sandbox/commands/run-tests-from-a-git-repository/ ,
https://developers.cloudflare.com/containers/api/durable-object-container/ ,
https://developers.cloudflare.com/containers/guides/image-management/ ,
https://developers.cloudflare.com/containers/platform/limits/ , https://developers.cloudflare.com/containers/guides/local-dev/ ,
https://developers.cloudflare.com/sandbox/sdk/migrate/api-map/ , https://developers.cloudflare.com/sandbox/concepts/lifetime/

### 0.x to 1.0 mapping (from the official API map)
| 0.x (what tutorials show) | 1.0 |
| --- | --- |
| `getSandbox(env.Sandbox, id)` | `env.SANDBOX.getByName(id)`, which returns a stub to **your own** DO class |
| `sandbox.exec("cmd")` gives `{stdout, stderr, exitCode, success}` | `await (await this.ctx.container.exec(argv, {cwd, env})).output()` gives `{stdout: ArrayBuffer, stderr: ArrayBuffer, exitCode}`. `success` becomes `exitCode === 0` |
| `gitCheckout(url, {branch, depth})` | **Removed.** Run `exec(["git","clone","--filter=blob:none","--depth","1","--branch",b,"--",url,dir])` |
| `setEnvVars()` | `container.start({ env })` or `exec(argv, { env })`. **`exec` does not inherit `start` env** (only `PATH`) |
| `exec(..., {timeout})` | Prefix with `["timeout","--kill-after=5","600", ...]`. Exit code 124 means it timed out. Or pass an `AbortSignal` |
| `writeFile` / `readFile` | `new Files(ctx.container).writeFile(path, content)` / `.readFile(path)`, which returns a `Response` |
| `sleepAfter` | `container.setInactivityTimeout(ms)` (at most 6 h). Call it after `start()` and again in the constructor |
| `enableInternet` default `true` | Default is now **`false`**, and the field is required in `start()` options |

If you really want the old API, `@cloudflare/sandbox@0.12.10` and its docs (`/sandbox/sdk/`) still exist. That path
is deprecated, and the 1.0 path is simpler for our use.

### wrangler.jsonc
```jsonc
{
  "compatibility_flags": ["nodejs_compat"],           // required by @cloudflare/sandbox (Files)
  "containers": [{
    "class_name": "SandboxDO",
    "scheduling_policy": "durable_object",            // lets the DO pick image and instance at runtime
    "images": { "checker": { "dockerfile": "./container/Dockerfile" } }
  }],
  "durable_objects": { "bindings": [{ "name": "SANDBOX", "class_name": "SandboxDO" }] },
  "exports": { "SandboxDO": { "type": "durable-object", "storage": "sqlite" } }
}
```
Without `images`, you can call `start({ image: "cloudflare/debian-trixie", entrypoint: ["sleep","infinity"], ... })`.
That is a Cloudflare-managed `node:24.20.0-trixie-slim` image, available only with `durable_object` scheduling, and
it needs Wrangler 4.141.0 or later locally. **It has no git** (it is a slim image), so we need our own Dockerfile.

### Dockerfile
Base image: `node:24-trixie-slim` is what the docs use. The managed image is pinned to `node:24.20.0-trixie-slim`.
**git is NOT in the base image**, so install it. `sandbox-shim` is needed only if you use `Files`, `S3Mount`, or
`DirectoryBackup`.
```dockerfile
FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g typescript@7.0.2
# Only needed if you use Files/S3Mount/DirectoryBackup; the tag must match the @cloudflare/sandbox version
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir /workspace && git config --system user.email bot@example.com && git config --system user.name bot
CMD ["sleep", "infinity"]
```
**UNCERTAIN:** TypeScript 7 is the native (Go) compiler and ships platform binaries as optional deps. A global npm
install should pull the linux-x64 binary, but verify that `tsc --version` works in the image. Pinning
`typescript@5` is the safe fallback. Images must be linux/amd64.

### DO code
```ts
import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox"; // optional

const dec = new TextDecoder();

export class SandboxDO extends DurableObject<Env> {
  private ensureRunning() {
    const c = this.ctx.container;
    if (!c) throw new Error("container binding not configured");
    if (!c.running) {
      c.start({
        image: c.images.checker,     // key from wrangler "images"
        enableInternet: true,        // needed for git clone over HTTPS (or use outbound interception)
        instance: "standard-1",      // default "lite" = 1/16 vCPU and 256 MiB, too small for tsc
        env: { CI: "1" },
      });
    }
    return c;
  }

  private async run(c: Container, argv: string[], cwd = "/workspace") {
    const p = await c.exec(["timeout", "--kill-after=5", "300", ...argv], { cwd }); // no shell
    const o = await p.output();      // buffers everything in DO memory (use streams for huge output)
    return { stdout: dec.decode(o.stdout), stderr: dec.decode(o.stderr), exitCode: o.exitCode };
  }

  async typecheck(repoUrl: string, branch: string, mergeBranch?: string) {
    const c = this.ensureRunning();
    try {
      let r = await this.run(c, ["git", "clone", "--filter=blob:none", "--branch", branch, "--", repoUrl, "/workspace/repo"], "/");
      if (r.exitCode !== 0) return { step: "clone", ...r };
      if (mergeBranch) {
        r = await this.run(c, ["bash", "-c", `git fetch origin ${mergeBranch} && git merge --no-edit FETCH_HEAD`], "/workspace/repo");
        if (r.exitCode !== 0) return { step: "merge", ...r };
      }
      r = await this.run(c, ["tsc", "--noEmit", "-p", "."], "/workspace/repo");
      return { step: "tsc", ...r };
    } finally {
      if (c.running) await c.destroy(); // one-shot sandbox per push
    }
  }

  async writeAndRead() {                // Files helper example (needs sandbox-shim in the image)
    const files = new Files(this.ensureRunning());
    await files.mkdir("/workspace", { recursive: true });
    await files.writeFile("/workspace/input.txt", "hello\n");
    return (await files.readFile("/workspace/input.txt")).text();
  }
}
```
Key `container` API facts:
- `start(opts)` returns **before** the container is ready. `exec()` waits for a container that is still starting.
- `start()` throws if the container is already running, so guard with `running`.
- `exec(cmd: string[], {cwd, env, stdin, stdout, stderr: "pipe"|"ignore"|"combined", user: "uid:gid", signal, pty})`
  returns `ExecProcess {pid, stdout, stderr, stdin, exitCode: Promise<number>, output(), kill(sig)}`.
  A non-zero exit does not throw. A missing binary **throws** ("Command `x` was not found").
- `exec` starts in `/` (it ignores `WORKDIR`). There is **no built-in timeout**. `kill()` reaches only the direct
  child, so use coreutils `timeout`.
- Each `exec` is a separate process. `cd` and `export` do not persist, so chain with `bash -c "a && b"`.
- Also available: `destroy(reason?)`, `setInactivityTimeout(ms)`, `monitor()`, `inspect()`, `snapshotContainer({name})`,
  `start({containerSnapshot})`, `interceptOutboundHttp(s)` (allow-list git hosts, inject tokens).
- **Lifetime:** code running inside the container does **not** count as activity. If the DO goes idle and the
  inactivity timeout ends, the container is killed even mid-`tsc`. While a Workflow step awaits the RPC, the DO is
  active, so a synchronous `typecheck()` RPC is fine.
- `user:` in exec does not restrict anything in deployed containers (all processes have root capabilities).

### Instance types (`start({instance})`) and limits
| type | vCPU | Mem | Disk |
| --- | --- | --- | --- |
| lite (default) | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

A custom size is `{vcpu, memoryMib, diskMb}` (1 to 4 vCPU, at least 3 GiB per vCPU, at most 12 GiB / 20 GB). Image
size can be at most the instance disk. Account image storage is 50 GB.
**UNCERTAIN:** the `start()` reference lists `"lite"|"standard-1".."standard-4"` and omits `"basic"`, while the limits
page lists `basic`. Use `standard-1` to be safe; it is also a sensible size for `tsc` on a real repo.
Containers need the Workers Paid plan.

### Local dev
- `wrangler dev` runs the container in **Docker**, so Docker Desktop or Colima must be running (`docker info`).
  `wrangler deploy` also needs Docker locally to build the image.
- Wrangler 4.136.0 or later for `durable_object` scheduling locally, and 4.141.0 or later for `cloudflare/debian-trixie`.
  We have 4.149.0, so both are fine.
- Press `[r]` in `wrangler dev` to rebuild the image. Worker code hot-reloads but container code does not.
- Differences from deploy: the hostname is longer than 63 chars when deployed, and local non-root users lack
  capabilities.

---

## 4. MCP server on the Worker

Sources: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/ ,
https://developers.cloudflare.com/agents/model-context-protocol/apis/agent-api/ ,
https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/ ,
https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/ ,
plus the type definitions in `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/client@2.0.0`.

### Recommended: stateless `createMcpHandler` (no DO, no migration)
```bash
pnpm add agents@0.28.0 @modelcontextprotocol/server@2.0.0 zod
```
```ts
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer(env: Env) {                 // a factory: a fresh server per request
  const server = new McpServer({ name: "agentmesh", version: "1.0.0" });
  server.registerTool(
    "get_status",
    { description: "Status of a push", inputSchema: z.object({ pushId: z.string() }) },
    async ({ pushId }) => {
      const row = await env.COORDINATOR.getByName("global").getPush(pushId);
      return { content: [{ type: "text", text: JSON.stringify(row) }] };
    },
  );
  // ...register 2 more tools the same way
  return server;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return createMcpHandler(() => createServer(env))(request, env, ctx);
    // ...other routes
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env, ctx) { /* section 5 */ },
} satisfies ExportedHandler<Env>;
```
- Pass a **factory**, not a server instance. **Do not** `export default createMcpHandler(...)`, because Wrangler
  treats a function default export as a WorkerEntrypoint class.
- Options: `route` (default `"/mcp"`, exact path), `corsOptions`, `allowedHostnames` / `allowedOriginHostnames`
  (needed on a custom domain), `legacy: "stateless" | "reject"`, `responseMode: "auto"|"json"|"sse"`.
- Origin/Host checks default to localhost and `*.workers.dev`. Origin-less clients (a Node script) are always allowed.
- Stateless: GET and DELETE on `/mcp` return 405 and there is no session ID. Keep durable state in the DO.
- SDK v2 `registerTool` wants `inputSchema: z.object({...})` (any Standard Schema). The raw-shape
  `{ pushId: z.string() }` form still type-checks but is marked `@deprecated` in the 2.0.0 types. The CF docs
  example still uses the raw shape.
- There is no auth. CORS is not authentication. For the hackathon, add a bearer-token check before calling the
  handler.

### Legacy: `McpAgent` (deprecated and feature-frozen, needs a DO)
```bash
pnpm add agents@0.28.0 @modelcontextprotocol/sdk@1.30.0 zod
```
```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";  // must be SDK v1
import { z } from "zod";
export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Demo", version: "1.0.0" });
  async init() {
    this.server.tool("add", { a: z.number(), b: z.number() },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
  }
}
export default MyMCP.serve("/mcp");   // Streamable HTTP
```
Config needs a DO binding plus a SQLite class. The docs still show `migrations`:
`"durable_objects":{"bindings":[{"name":"MCP_OBJECT","class_name":"MyMCP"}]}`,
`"migrations":[{"tag":"v1","new_sqlite_classes":["MyMCP"]}]`.
If the rest of the Worker uses `exports`, declare `"MyMCP": {"type":"durable-object","storage":"sqlite"}` there
instead, because you cannot mix the two flows.
**UNCERTAIN:** the binding name. Older templates use `MCP_OBJECT`, and the current page does not show it.
`serveSSE("/sse")` is **not mentioned anywhere** in the current McpAgent docs. Treat SSE transport as gone or
deprecated and use `serve()`.

### Calling a tool from a plain Node script (Streamable HTTP client, SDK v2)
```bash
pnpm add @modelcontextprotocol/client@2.0.0   # add "types": ["node"] to tsconfig with TS >= 6
```
```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "cli", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"));
await client.connect(transport);
console.log((await client.listTools()).tools.map((t) => t.name));
const result = await client.callTool({ name: "get_status", arguments: { pushId: "abc" } });
if (result.isError) console.error(result.content); else console.log(result.content);
await client.close();
```
The signatures come from the 2.0.0 `.d.mts` files (`Client.connect(transport)`,
`StreamableHTTPClientTransport(url: URL, opts?)`, `callTool({name, arguments})`).
**UNCERTAIN:** I did not run this; `close()` is inherited from Protocol. A v1 equivalent is
`import { Client } from "@modelcontextprotocol/sdk/client/index.js"` with
`import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"`.
The v2 client implements the 2026-07-28 MCP spec.

---

## 5. Queues consumer + Artifacts push events

Sources: https://developers.cloudflare.com/queues/configuration/configure-queues/ ,
https://developers.cloudflare.com/queues/configuration/javascript-apis/ ,
https://developers.cloudflare.com/queues/configuration/batching-retries/ ,
https://developers.cloudflare.com/artifacts/guides/event-subscriptions/ ,
https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/create/ ,
plus the `wrangler@4.149.0` source (`src/queues/cli/commands/subscription/create.ts`).

### wrangler.jsonc
```jsonc
"queues": {
  "consumers": [{
    "queue": "artifacts-events",
    "max_batch_size": 10,      // default 10
    "max_batch_timeout": 0,    // seconds, default 5, min 0, max 60. Use 0 for the lowest latency
    "max_retries": 3,          // default 3
    "dead_letter_queue": "artifacts-events-dlq"  // optional
  }]
}
```
(The queue must exist: `wrangler queues create artifacts-events`.)

### Handler
```ts
type PushEvent = {
  type: "cf.artifacts.repo.pushed";
  source: { type: "artifacts.repo"; namespace: string; repoName: string };
  payload: { ref: string; before: string; after: string; commits: Array<{ id: string; message: string;
    timestamp: string; author: { name: string; email: string }; parents: string[] }>;
    totalCommitsCount: number; commitsTruncated: boolean };
  metadata: { accountId: string; eventSubscriptionId: string; eventSchemaVersion: 1; eventTimestamp: string };
};

export default {
  async queue(batch: MessageBatch<PushEvent>, env: Env, ctx: ExecutionContext) {
    for (const msg of batch.messages) {      // use for..of, not forEach, with async work
      const e = msg.body;
      if (e.type === "cf.artifacts.repo.pushed") {
        await env.PUSH_CHECKS.create({ id: `${e.source.repoName}-${e.payload.after}`.slice(0, 100),
          params: { repo: e.source.repoName, sha: e.payload.after, pushId: e.payload.after } });
      }
      msg.ack();                             // or msg.retry({ delaySeconds })
    }
  },
} satisfies ExportedHandler<Env, PushEvent>;
```
- If `queue()` throws, the whole batch is retried, except messages already `ack()`ed.
- `batch.ackAll()` and `batch.retryAll()` exist. A message has `id`, `timestamp`, `body`, `attempts`.
- Consumer wall time is 15 min and CPU is 30 s by default (configurable with `limits.cpu_ms`).
- The pushed event's `source.repoName` is camelCase, while the subscription request uses snake_case `repo_name`.
- **UNCERTAIN:** I am not sure whether the remote event subscription delivers to `wrangler dev` local queues. It
  almost certainly does not. Test the consumer with `wrangler dev --remote` or deploy, or send a fake message to
  the queue.

### Create the subscription (REST)
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "artifacts-push",
    "enabled": true,
    "source": { "type": "artifacts.repo", "namespace": "<NAMESPACE>", "repo_name": "<REPO>" },
    "destination": { "type": "queues.queue", "queue_id": "<QUEUE_ID>" },
    "events": ["pushed"]
  }'
```
- **Body shape: confirmed.** `name`, `enabled`, `source`, `destination {type:"queues.queue", queue_id}`, and
  `events: string[]` match the API reference exactly. The `artifacts.repo` source with `namespace` and `repo_name`
  is confirmed by the Artifacts guide ("Subscribe to the `artifacts.repo` source with a `namespace` and
  `repo_name`") and by wrangler 4.149 source, which builds
  `{ type: "artifacts.repo", namespace, repo_name }`.
- **UNCERTAIN:** the published API reference's `source` union does **not yet list** `artifacts`/`artifacts.repo`.
  It lists 9 others (images, kv, r2, superSlurper, vectorize, workersAi.model, workersBuilds.worker,
  workers.script, workflows.workflow). The docs list event names in short form (`pushed`, `cloned`, ...) and say
  `events: ["pushed"]`. Wrangler passes `--events` through verbatim. The delivered `type` is
  `cf.artifacts.repo.pushed`.
- **Token permission:** the API reference lists "Accepted Permissions (at least one required)": **`Queues Write`** or
  **`Workers Scripts Write`**. **UNCERTAIN:** whether an Artifacts read permission is also needed for an
  `artifacts.repo` source. The docs do not say.
- `queue_id` is the queue's ID, not its name. Get it with `wrangler queues info artifacts-events` or
  `wrangler queues list`.
- **Easier: Wrangler CLI** (4.149 has the flags, though they are missing from the public docs page). It resolves
  the queue ID for you:
  ```bash
  pnpm wrangler queues subscription create artifacts-events \
    --source artifacts.repo --source-namespace <NAMESPACE> --source-repo-name <REPO> --events pushed
  ```
  Account-wide alternative: `--source artifacts` (no namespace or repo) for the created, deleted, forked, and
  imported events.

### Undocumented: `triggers.events` (Artifacts event to Workflow, no queue)
`wrangler@4.149.0` validates and deploys a config like the one below. Each event needs a `type` (full
`cf.artifacts.repo.*` name), an optional `filter` with only `namespace`/`repo_name`, and a non-empty `targets`
array. Each target must be `{type:"workflow", workflow_name}` for a Workflow defined by this Worker.
```jsonc
"triggers": { "events": [{ "type": "cf.artifacts.repo.pushed",
  "filter": { "namespace": "<NS>", "repo_name": "<REPO>" },
  "targets": [{ "type": "workflow", "workflow_name": "push-checks" }] }] }
```
**UNCERTAIN / not in public docs.** This could replace the Queue hop. Do not rely on it without testing.

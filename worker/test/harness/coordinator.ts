/**
 * A real Coordinator Durable Object in Node: its SQL runs on node:sqlite (the same SQLite dialect), and the
 * bindings it touches (Artifacts heads, the push Workflow) are small fakes the test controls.
 */
import { DatabaseSync } from "node:sqlite";
import { Coordinator } from "../../src/coordinator";

import { sqlStorage } from "./sql";

type Row = Record<string, unknown>;

/** `prepare`: runs on the empty database before the Coordinator is built (e.g. an old schema, to test migrations). */
export function airport(baseline = "base-repo", vars: Record<string, string> = {}, prepare?: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  prepare?.(db);
  const heads = new Map<string, string>([[baseline, "main0"]]);
  const pipelines: Array<{ id: string; params: { fork: string; sha: string; kind: string; others: Array<{ name: string; sha: string }> } }> = [];
  let alarm: number | null = null;
  /** Runs inside PUSH_PIPELINE.create, i.e. while the Coordinator is awaiting it: lets a test interleave another call. */
  const hooks: { onCreate?: (id: string) => Promise<void> | void } = {};
  const ctx = {
    storage: {
      sql: sqlStorage(db),
      transactionSync: <T>(fn: () => T) => fn(),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => void (alarm = at),
    },
    waitUntil: (_p: Promise<unknown>) => undefined,
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  };
  const env = {
    ...vars,
    ARTIFACTS: {
      get: async (repo: string) => ({
        log: async () => {
          const forced = await self.onHeadRead?.(repo);
          const h = forced ?? heads.get(repo);
          return h ? [{ hash: h }] : [];
        },
        createToken: async () => ({ plaintext: "token" }),
        info: async () => ({ remote: `https://artifacts.example/${repo}` }),
        [Symbol.dispose]: () => undefined,
      }),
    },
    /** The checker container: tests answer each run (land, notes) through `checker`. */
    CHECKER: {
      getByName: () => ({ run: async (input: { mode: string }) => JSON.stringify(await self.checker(input)) }),
    },
    PUSH_PIPELINE: {
      create: async (opts: (typeof pipelines)[number]) => {
        if (pipelines.some((p) => p.id === opts.id)) throw new Error("(instance.already_exists) An instance with this ID already exists. [code: 10405]");
        pipelines.push(opts);
        await hooks.onCreate?.(opts.id);
      },
    },
  };
  const co = new Coordinator(ctx as never, env as never);
  const q = <T = Row>(query: string, ...params: unknown[]) => ctx.storage.sql.exec<T>(query, ...params).toArray();
  const self = {
    co, db, heads, pipelines, q, hooks,
    meta: (key: string) => q<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value ?? null,
    fork: (name: string) => q<Row>("SELECT * FROM forks WHERE name = ?", name)[0],
    events: (kind: string) => q<{ detail: string; fork: string | null }>("SELECT detail, fork FROM event_log WHERE kind = ? ORDER BY id", kind),
    /** A push event: the repo's head in Artifacts moves to `sha`, then the event is delivered. */
    async push(repo: string, sha: string) {
      heads.set(repo, sha);
      await co.onPush(repo, sha, "event");
    },
    /** Override what Artifacts answers for one read of `repo` (to model a stale or racing read). */
    onHeadRead: undefined as undefined | ((repo: string) => Promise<string | undefined>),
    /** What the checker container answers. Default: a landing succeeds onto main, notes are written. */
    // Like the real one: refuses (retry) unless main is where the Coordinator pinned it, and moves main on success.
    checker: async (input: { mode: string; fork?: { expectedHead?: string }; baseline?: { expectedHead?: string } }): Promise<unknown> => {
      if (input.mode !== "land") return { mode: "notes", written: [] };
      if (input.baseline?.expectedHead !== heads.get(baseline)) return { mode: "land", landed: false, retry: true, reason: "main moved; retry" };
      const landedSha = `landed-${input.fork?.expectedHead ?? "x"}`;
      heads.set(baseline, landedSha);
      return { mode: "land", landed: true, landedSha, forkHead: input.fork?.expectedHead, merged: true };
    },
    /** Add an active fork the way createFork leaves it (without going through Artifacts). */
    addFork(name: string, base = heads.get(baseline)!) {
      q(
        `INSERT INTO forks(name, agent, pr, status, created_at, base_sha, head_sha, processed_sha, remote) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, '')`,
        name, name, q("SELECT name FROM forks").length + 1, Date.now(), base, base, base,
      );
      heads.set(name, base);
    },
  };
  return self;
}

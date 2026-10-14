/**
 * A real Coordinator Durable Object in Node: its SQL runs on node:sqlite (the same SQLite dialect), and the
 * bindings it touches (Artifacts heads, the push Workflow) are small fakes the test controls.
 */
import { DatabaseSync } from "node:sqlite";
import { Coordinator } from "../../src/coordinator";

type Row = Record<string, unknown>;

function sqlStorage(db: DatabaseSync) {
  return {
    exec<T = Row>(query: string, ...params: unknown[]) {
      let rows: Row[] = [];
      if (params.length === 0 && /;\s*\S/.test(query.trim().replace(/;\s*$/, ""))) db.exec(query); // a multi-statement script (the schema)
      else rows = db.prepare(query).all(...(params as never[])) as Row[];
      return {
        toArray: () => rows as T[],
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0] as T;
        },
        [Symbol.iterator]: () => (rows as T[])[Symbol.iterator](),
      };
    },
  };
}

export function airport(baseline = "base-repo") {
  const db = new DatabaseSync(":memory:");
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
    ARTIFACTS: {
      get: async (repo: string) => ({
        log: async () => (heads.has(repo) ? [{ hash: heads.get(repo)! }] : []),
        [Symbol.dispose]: () => undefined,
      }),
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
  return {
    co, db, heads, pipelines, q, hooks,
    meta: (key: string) => q<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value ?? null,
    fork: (name: string) => q<Row>("SELECT * FROM forks WHERE name = ?", name)[0],
    events: (kind: string) => q<{ detail: string; fork: string | null }>("SELECT detail, fork FROM event_log WHERE kind = ? ORDER BY id", kind),
    /** Add an active fork the way createFork leaves it (without going through Artifacts). */
    addFork(name: string, base = heads.get(baseline)!) {
      q(
        `INSERT INTO forks(name, agent, pr, status, created_at, base_sha, head_sha, processed_sha, remote) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, '')`,
        name, name, q("SELECT name FROM forks").length + 1, Date.now(), base, base, base,
      );
      heads.set(name, base);
    },
  };
}

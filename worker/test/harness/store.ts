/**
 * A real RepoStore Durable Object in Node: SQL on node:sqlite, and fakes for the bindings it touches
 * (Artifacts branch heads, the ReviewRun Workflow, the checker container for merges).
 */
import { DatabaseSync } from "node:sqlite";
import { RepoStore } from "../../src/review/store";
import { sqlStorage } from "./sql";

type Row = Record<string, unknown>;

export function store(repo = "shop") {
  const db = new DatabaseSync(":memory:");
  /** Branch → head sha, as Artifacts would answer. */
  const heads = new Map<string, string>([["main", "m0"]]);
  const runs: Array<{ id: string; params: { repo: string; pr: number; sha: string; run: number } }> = [];
  const terminated: string[] = [];
  const self = {
    db,
    heads,
    runs,
    terminated,
    /** What the checker container answers for `merge` (default: CI passes, pushed). */
    checker: async (input: { mode: string; [k: string]: unknown }): Promise<unknown> => ({ mode: input.mode, merged: true, sha: `merged-${String(input.expectedSource)}`, checks: [] }),
    checkerCalls: [] as Array<Record<string, unknown>>,
    co: undefined as unknown as RepoStore,
    q: <T = Row>(query: string, ...params: unknown[]) => sqlStorage(db).exec<T>(query, ...params).toArray(),
    /** A push to `branch`: Artifacts moves the head, then the event reaches the store. */
    async push(branch: string, sha: string) {
      heads.set(branch, sha);
      await self.co.onPush(`refs/heads/${branch}`, sha);
    },
  };
  const ctx = {
    storage: { sql: sqlStorage(db), transactionSync: <T>(fn: () => T) => fn() },
    waitUntil: (_p: Promise<unknown>) => undefined,
  };
  const env = {
    ARTIFACTS: {
      get: async (_repo: string) => ({
        log: async ({ ref }: { ref: string }) => (heads.has(ref) ? [{ hash: heads.get(ref)! }] : []),
        createToken: async (scope: string) => ({ plaintext: `${scope}-token` }),
        info: async () => ({ remote: `https://artifacts.example/${repo}` }),
        [Symbol.dispose]: () => undefined,
      }),
    },
    REVIEW_RUN: {
      create: async (opts: (typeof runs)[number]) => {
        if (runs.some((r) => r.id === opts.id)) throw new Error("(instance.already_exists) [code: 10405]");
        runs.push(opts);
        return { id: opts.id };
      },
      get: async (id: string) => ({ terminate: async () => void terminated.push(id) }),
    },
    CHECKER: {
      getByName: () => ({
        run: async (input: { mode: string; [k: string]: unknown }) => {
          self.checkerCalls.push(input);
          return JSON.stringify(await self.checker(input));
        },
      }),
    },
  };
  self.co = new RepoStore(ctx as never, env as never);
  return Object.assign(self, { init: () => self.co.init(repo) });
}

/** A Durable Object's `ctx.storage.sql` on node:sqlite (the same SQLite dialect), for tests. */
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export function sqlStorage(db: DatabaseSync) {
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


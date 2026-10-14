import { test } from "node:test";
import assert from "node:assert/strict";
import { checkerFor, CHECKER_POOL } from "../src/checker";

const env = () => {
  const names: string[] = [];
  return { names, env: { CHECKER: { getByName: (n: string) => (names.push(n), {}) } } as unknown as Env };
};

test("a push's own check and its pair checks go to the same container (issue #9)", () => {
  const { names, env: e } = env();
  checkerFor(e, "shop", "shop--pr1"); // check on main
  checkerFor(e, "shop", "shop--pr1"); // its pair checks are keyed by the pushing fork too
  assert.equal(new Set(names).size, 1);
});

test("pushes spread over a small pool per baseline", () => {
  const { names, env: e } = env();
  for (let i = 1; i <= 12; i++) checkerFor(e, "shop", `shop--pr${i}`);
  const used = new Set(names);
  assert.ok(used.size > 1 && used.size <= CHECKER_POOL);
  for (const n of used) assert.match(n, /^checker-shop-\d$/);
});

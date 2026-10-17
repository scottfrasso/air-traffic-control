import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTE_TABLE } from "../src/review/api";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/review/ui.html"), "utf8");

test("the UI never writes server text as HTML: no innerHTML / outerHTML / insertAdjacentHTML / document.write", () => {
  assert.doesNotMatch(html, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/);
});

test("every API call the UI makes matches a route the API serves", () => {
  const calls = [...html.matchAll(/api\(\s*"(GET|POST|DELETE)",\s*`([^`]+)`/g)].map((m) => ({ method: m[1]!, path: m[2]!.replace(/\$\{[^}]+\}/g, "1").replace(/\?.*$/, "") }));
  assert.ok(calls.length >= 10, `found only ${calls.length} api(...) calls`);
  for (const c of calls) assert.ok(ROUTE_TABLE.some((r) => r.method === c.method && r.pattern.test(c.path)), `${c.method} ${c.path} has no API route`);
});

test("the UI covers the PR flow: ready, draft, approve (with the head it shows), resolve, merge", () => {
  for (const path of ["/ready`", "/draft`", "/approve`", "/resolve`", "/merge`", "/diff`"]) assert.ok(html.includes(path), `no call ending in ${path}`);
  assert.match(html, /approve`,\s*\{\s*sha:\s*view\.pr\.head\s*\}/);
});

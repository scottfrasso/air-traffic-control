import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, signature } from "../src/webhooks";

const fake = (answers: Array<number | "throw">) => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const a = answers.shift();
    if (a === "throw") throw new Error("timed out");
    return new Response("", { status: a ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};
const noWait = async () => undefined;

test("a webhook that times out or answers 5xx is retried once; a 4xx is not (issue #10)", async () => {
  let f = fake(["throw", 200]);
  assert.deepEqual(await deliver("https://hook", null, "{}", f.fetcher, noWait), { ok: true, attempts: 2 });
  f = fake([503, 503]);
  assert.deepEqual(await deliver("https://hook", null, "{}", f.fetcher, noWait), { ok: false, attempts: 2 });
  f = fake([404]);
  assert.deepEqual(await deliver("https://hook", null, "{}", f.fetcher, noWait), { ok: false, attempts: 1 });
  assert.equal(f.calls.length, 1);
});

test("signed webhooks carry the HMAC of the body", async () => {
  const f = fake([200]);
  await deliver("https://hook", "s3cret", '{"a":1}', f.fetcher, noWait);
  assert.equal(f.calls[0]!.headers["x-atc-signature"], await signature("s3cret", '{"a":1}'));
  assert.match(f.calls[0]!.headers["x-atc-signature"]!, /^sha256=[0-9a-f]{64}$/);
});

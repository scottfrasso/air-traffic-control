import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeBatch, retryDelaySeconds, type QueueMessage } from "../src/queue";

const msg = (id: string, body: string, attempts = 1) => {
  const m = { id, body, attempts, acked: false, retried: undefined as number | undefined };
  const q: QueueMessage<string> & { acked: boolean; retried?: number } = Object.assign(m, {
    ack: () => void (m.acked = true),
    retry: (o?: { delaySeconds?: number }) => void (m.retried = o?.delaySeconds ?? 0),
  });
  return q;
};

test("one failing message is retried on its own; the others are acked and not redelivered (issue #7)", async () => {
  const batch = [msg("1", "ok"), msg("2", "boom"), msg("3", "ok")];
  const handled: string[] = [];
  const logs: string[] = [];
  await consumeBatch(batch, async (b) => {
    handled.push(b);
    if (b === "boom") throw new Error("store unavailable");
  }, (l) => logs.push(l));
  assert.deepEqual(handled, ["ok", "boom", "ok"]); // the loop went on past the failure
  assert.deepEqual(batch.map((m) => [m.acked, m.retried]), [[true, undefined], [false, 5], [true, undefined]]);
  assert.match(logs[0]!, /message 2 failed \(attempt 1\).*store unavailable/);
});

test("retries back off and are capped at a minute", () => {
  assert.deepEqual([1, 2, 3, 4, 10].map(retryDelaySeconds), [5, 10, 20, 40, 60]);
});

test("a thrown non-Error is logged by its value, not as undefined", async () => {
  const logs: string[] = [];
  await consumeBatch([msg("9", "x")], async () => { throw "plain string"; }, (l) => logs.push(l));
  assert.match(logs[0]!, /plain string/);
});

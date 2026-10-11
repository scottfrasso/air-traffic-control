import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteWriter, takeBatch } from "../src/notes";

const n = (bytes: number) => ({ note: "x".repeat(bytes) });

test("a batch is capped by count and by bytes, oldest first", () => {
  assert.equal(takeBatch(Array.from({ length: 25 }, () => n(10))).length, 10);
  assert.equal(takeBatch([n(30), n(30), n(30)], { count: 10, bytes: 70 }).length, 2);
});

test("a single note bigger than the byte cap still goes, alone", () => {
  assert.equal(takeBatch([n(100), n(1)], { count: 10, bytes: 50 }).length, 1);
  assert.deepEqual(takeBatch([]), []);
});

const noSleep = (log: number[]) => async (ms: number) => void log.push(ms);

test("the writer retries with backoff, then gives up for the alarm", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await new NoteWriter(async () => (calls++, false), noSleep(sleeps), 4, 100).run();
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [100, 200, 400, 800]);
});

test("a throwing attempt counts as a failure, never a rejection", async () => {
  let calls = 0;
  await new NoteWriter(async () => { calls++; throw new Error("boom"); }, noSleep([]), 2, 1).run();
  assert.equal(calls, 2);
});

test("one writer at a time; a call during a write makes it go round again", async () => {
  let calls = 0;
  let release!: () => void;
  const w = new NoteWriter(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((r) => (release = r));
    return true;
  }, noSleep([]));
  const first = w.run();
  await new Promise((r) => setImmediate(r));
  const second = w.run(); // a landing while the first write runs
  assert.equal(second, first);
  release();
  await first;
  assert.equal(calls, 2);
  await w.run(); // a fresh run after it finished
  assert.equal(calls, 3);
});

test("stops as soon as nothing is left", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await new NoteWriter(async () => (calls++, calls >= 2), noSleep(sleeps), 4, 1).run();
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1]);
});

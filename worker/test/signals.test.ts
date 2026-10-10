import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSignals, intentConflicts, type IndexSnapshot } from "../src/signals";

const snap: IndexSnapshot = {
  forks: [{ name: "shop--a", agent: "a" }, { name: "shop--b", agent: "b" }],
  touched: [
    { fork: "shop--a", path: "src/pricing.ts", change: "modified" },
    { fork: "shop--a", path: "src/cart.ts", change: "modified" },
    { fork: "shop--b", path: "src/checkout.ts", change: "added" },
  ],
  symbolChanges: [
    { fork: "shop--a", path: "src/pricing.ts", name: "applyDiscount", change: "signature_changed", before_sig: "(price:Cents,percent:number):Cents", after_sig: "(price:Cents,discount:Discount):Cents" },
    { fork: "shop--b", path: "src/checkout.ts", name: "memberPrice", change: "added", before_sig: null, after_sig: "(price:Cents):Cents" },
  ],
  uses: [
    { fork: "shop--b", path: "src/checkout.ts", symbol: "applyDiscount", from_path: "src/pricing.ts" },
    { fork: "shop--a", path: "src/cart.ts", symbol: "applyDiscount", from_path: "src/pricing.ts" },
  ],
  intents: [],
};

test("signature change reaches the fork that uses the symbol, and the changer learns its dependents", () => {
  const sigs = deriveSignals(snap);
  const toB = sigs.find((s) => s.fork === "shop--b" && s.kind === "signature_change");
  assert.ok(toB, "B is told");
  assert.match(toB.message, /shop--a is changing the signature of applyDiscount \(src\/pricing\.ts\)/);
  assert.match(toB.message, /you use it in src\/checkout\.ts/);
  assert.ok(sigs.some((s) => s.fork === "shop--a" && s.about_fork === "shop--b" && s.kind === "signature_change"), "A is told about B");
  assert.equal(sigs.filter((s) => s.kind === "overlap").length, 0, "no file overlap in this scenario");
});

test("file overlap is symmetric; dedupe keys are stable", () => {
  const s2 = { ...snap, touched: [...snap.touched, { fork: "shop--b", path: "src/cart.ts", change: "modified" }] };
  const sigs = deriveSignals(s2);
  const overlaps = sigs.filter((s) => s.kind === "overlap");
  assert.deepEqual(overlaps.map((s) => s.fork).sort(), ["shop--a", "shop--b"]);
  assert.deepEqual(deriveSignals(s2).map((s) => s.dedupe_key), sigs.map((s) => s.dedupe_key));
});

test("intents: declaring a touch on a changed symbol reports the collision and notifies the other fork", () => {
  const conflicts = intentConflicts(snap, "shop--b", ["src/pricing.ts"], ["applyDiscount"]);
  assert.ok(conflicts.some((c) => c.fork === "shop--a" && /signature changed applyDiscount/.test(c.reason)));
  const withIntent = { ...snap, intents: [{ fork: "shop--b", description: "use member discounts", files: ["src/pricing.ts"], symbols: ["applyDiscount"] }] };
  const sigs = deriveSignals(withIntent);
  assert.ok(sigs.some((s) => s.fork === "shop--a" && s.kind === "intent_overlap"));
});

test("inactive forks produce no signals", () => {
  assert.equal(deriveSignals({ ...snap, forks: [{ name: "shop--a", agent: "a" }] }).length, 0);
});

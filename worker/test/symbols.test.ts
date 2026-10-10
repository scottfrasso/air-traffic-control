import { test } from "node:test";
import assert from "node:assert/strict";
import { changedLines, diffExports, extractExports, extractImports, resolveImport } from "../src/symbols";

const pricingV1 = `import type { Cents } from "./money";

export function applyDiscount(price: Cents, percent: number): Cents {
  return Math.round(price * (1 - percent / 100));
}

export function applyTax(price: Cents, rate: number): Cents {
  return Math.round(price * (1 + rate));
}
`;

const pricingV2 = `import type { Cents } from "./money";

export interface Discount {
  kind: "percent" | "fixed";
  value: number;
}

export function applyDiscount(
  price: Cents,
  discount: Discount,
): Cents {
  return discount.kind === "percent" ? Math.round(price * (1 - discount.value / 100)) : price - discount.value;
}

export function applyTax(price: Cents, rate: number): Cents {
  // tweak
  return Math.round(price * (1 + rate));
}
`;

test("extracts function signatures across lines", () => {
  const v2 = extractExports(pricingV2);
  const fn = v2.find((s) => s.name === "applyDiscount");
  assert.equal(fn?.kind, "function");
  assert.equal(fn?.signature, "(price:Cents,discount:Discount,):Cents");
  assert.deepEqual(v2.map((s) => s.name).sort(), ["Discount", "applyDiscount", "applyTax"]);
});

test("diffExports classifies changes; comments don't count as body changes", () => {
  const delta = diffExports(extractExports(pricingV1), extractExports(pricingV2));
  const by = Object.fromEntries(delta.map((d) => [d.name, d.change]));
  assert.deepEqual(by, { applyDiscount: "signature_changed", Discount: "added" });
});

test("const arrow functions, classes, generics", () => {
  const src = `export const total = (a: number, b: number): number => a + b;
export const RATE: number = 0.08;
export class Cart<T> { items: T[] = []; }
export async function load<T extends object>(id: string): Promise<T> { return {} as T; }
export type Id = string;`;
  const ex = Object.fromEntries(extractExports(src).map((s) => [s.name, s]));
  assert.equal(ex.total?.signature, "(a:number,b:number):number=>");
  assert.equal(ex.RATE?.signature, "number");
  assert.equal(ex.Cart?.kind, "class");
  assert.equal(ex.load?.signature, "<T extends object>(id:string):Promise<T>");
  assert.equal(ex.Id?.kind, "type");
});

test("imports and resolution", () => {
  const imps = extractImports(`import { applyDiscount, applyTax as tax, type Discount } from "./pricing";
import type { Cents } from "../lib/money";
import React from "react";`);
  assert.deepEqual(imps, [
    { name: "applyDiscount", from: "./pricing" },
    { name: "applyTax", from: "./pricing" },
    { name: "Discount", from: "./pricing" },
    { name: "Cents", from: "../lib/money" },
    { name: "default", from: "react" },
  ]);
  const exists = (p: string) => ["src/pricing.ts", "lib/money.ts"].includes(p);
  assert.equal(resolveImport("src/checkout.ts", "./pricing", exists), "src/pricing.ts");
  assert.equal(resolveImport("src/checkout.ts", "../lib/money", exists), "lib/money.ts");
  assert.equal(resolveImport("src/a.ts", "react", exists), null);
});

test("changedLines", () => {
  assert.equal(changedLines("a\nb\nc", "a\nB\nc\nd"), 3);
  assert.equal(changedLines("x", "x"), 0);
});

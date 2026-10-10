import type { Cents } from "./money";

export function applyDiscount(price: Cents, percent: number): Cents {
  return Math.round(price * (1 - percent / 100));
}

export function applyTax(price: Cents, rate: number): Cents {
  return Math.round(price * (1 + rate));
}

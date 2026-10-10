/**
 * The deterministic edits our scripted agents make to shop-core.
 *   A: changes applyDiscount(price, percent) → applyDiscount(price, discount: Discount), updates its caller in cart.ts.
 *   B: adds a NEW caller of applyDiscount in a new file, src/checkout.ts, using the old signature.
 * Each fork typechecks alone and plain git merges them cleanly, but the merge doesn't typecheck.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function agentAChangeSignature(dir: string) {
  writeFileSync(
    join(dir, "src/pricing.ts"),
    `import type { Cents } from "./money";

export interface Discount {
  kind: "percent" | "fixed";
  value: number;
}

export function applyDiscount(price: Cents, discount: Discount): Cents {
  if (discount.kind === "fixed") return Math.max(0, price - discount.value);
  return Math.round(price * (1 - discount.value / 100));
}

export function applyTax(price: Cents, rate: number): Cents {
  return Math.round(price * (1 + rate));
}
`,
  );
  const cart = join(dir, "src/cart.ts");
  writeFileSync(
    cart,
    readFileSync(cart, "utf8").replace(
      "applyDiscount(subtotal(items), discountPercent)",
      'applyDiscount(subtotal(items), { kind: "percent", value: discountPercent })',
    ),
  );
}

export function agentBAddCaller(dir: string) {
  writeFileSync(
    join(dir, "src/checkout.ts"),
    `import type { Cents } from "./money";
import { applyDiscount } from "./pricing";

/** Members get 15% off at checkout. */
export function memberPrice(price: Cents): Cents {
  return applyDiscount(price, 15);
}
`,
  );
}

export function agentBFixCaller(dir: string) {
  const file = join(dir, "src/checkout.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace("applyDiscount(price, 15)", 'applyDiscount(price, { kind: "percent", value: 15 })'));
}

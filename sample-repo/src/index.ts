import { cartTotal, type LineItem } from "./cart";
import { formatCents, toCents } from "./money";

const items: LineItem[] = [
  { sku: "mug", unitPrice: toCents(12.5), quantity: 2 },
  { sku: "tee", unitPrice: toCents(20), quantity: 1 },
];

console.log(formatCents(cartTotal(items, 10, 0.08)));

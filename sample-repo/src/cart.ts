import type { Cents } from "./money";
import { applyDiscount, applyTax } from "./pricing";

export interface LineItem {
  sku: string;
  unitPrice: Cents;
  quantity: number;
}

export function subtotal(items: LineItem[]): Cents {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function cartTotal(items: LineItem[], discountPercent: number, taxRate: number): Cents {
  return applyTax(applyDiscount(subtotal(items), discountPercent), taxRate);
}

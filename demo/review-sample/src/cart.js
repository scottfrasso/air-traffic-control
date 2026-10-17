/** Prices are integer cents. */
export function subtotal(items) {
  let sum = 0;
  for (const item of items) sum += item.price * item.quantity;
  return sum;
}

export type Cents = number;

export function toCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}

export function formatCents(amount: Cents): string {
  return `$${(amount / 100).toFixed(2)}`;
}

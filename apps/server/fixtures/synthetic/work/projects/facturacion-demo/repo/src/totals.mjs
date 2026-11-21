export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function invoiceTotal(items, { discountPct = 0, vatPct = 21 } = {}) {
  const discounted = subtotal(items) - discountPct;
  return Math.round(discounted * (1 + vatPct / 100) * 100) / 100;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceTotal, subtotal } from "../src/totals.mjs";

const items = [
  { unitPrice: 400, quantity: 2 },
  { unitPrice: 200, quantity: 1 },
];

test("subtotal suma precio por cantidad", () => {
  assert.equal(subtotal(items), 1000);
});

test("total sin descuento aplica el IVA", () => {
  assert.equal(invoiceTotal(items), 1210);
});

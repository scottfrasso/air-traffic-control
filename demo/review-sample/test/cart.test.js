import { test } from "node:test";
import assert from "node:assert/strict";
import { subtotal } from "../src/cart.js";

test("subtotal adds price × quantity in cents", () => {
  assert.equal(subtotal([{ price: 250, quantity: 2 }, { price: 100, quantity: 1 }]), 600);
});

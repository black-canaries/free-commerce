import { z } from "zod";
import { DeliveryType, VariantId } from "./catalog.js";
import { idSchema } from "./id.js";
import { CurrencyCode } from "./money.js";
import { Timestamp } from "./time.js";

export const CartId = idSchema("cart");

/**
 * Snapshot of a variant at add time. `unitPrice` is the fixed price, or the customer's chosen amount
 * for `customer_defined` variants. `quantityUnit` is a display label only ("kg", "hour").
 */
export const CartLine = z.strictObject({
  id: idSchema("line"),
  variantId: VariantId,
  title: z.string().min(1),
  deliveryType: DeliveryType,
  taxCategory: z.string().min(1),
  quantity: z.number().int().positive(),
  quantityUnit: z.string().min(1).optional(),
  unitPrice: z.number().int().nonnegative(),
});
export type CartLine = z.infer<typeof CartLine>;

/** Single-currency. Totals are never stored; they are derived by `cartTotals` in `@free-commerce/core`. */
export const Cart = z.strictObject({
  id: CartId,
  currency: CurrencyCode,
  lines: z.array(CartLine),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Cart = z.infer<typeof Cart>;

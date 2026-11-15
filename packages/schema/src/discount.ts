import { z } from "zod";
import { idSchema } from "./id.js";
import { CurrencyCode } from "./money.js";
import { Timestamp } from "./time.js";

export const DiscountId = idSchema("disc");

const base = {
  id: DiscountId,
  /** Case-insensitive for customers: stored upper-case, unique per store. */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,32}$/),
  active: z.boolean(),
  /** Cart subtotal (before discount) needed to apply the code. */
  minSubtotal: z.number().int().positive().optional(),
  startsAt: Timestamp.optional(),
  endsAt: Timestamp.optional(),
  /** Redemptions across all customers. */
  usageLimit: z.number().int().positive().optional(),
  perCustomerLimit: z.number().int().positive().optional(),
};

/**
 * A discount code. `percentage` is basis points off the cart subtotal; `fixed` is a minor-unit amount
 * in one currency; `free_shipping` zeroes shipping and only applies to carts that ship.
 */
export const DiscountCode = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("percentage"),
    basisPoints: z.number().int().min(1).max(10_000),
  }),
  z.strictObject({
    ...base,
    type: z.literal("fixed"),
    amount: z.number().int().positive(),
    currency: CurrencyCode,
  }),
  z.strictObject({ ...base, type: z.literal("free_shipping") }),
]);
export type DiscountCode = z.infer<typeof DiscountCode>;

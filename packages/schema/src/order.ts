import { z } from "zod";
import { DeliveryType, VariantId } from "./catalog.js";
import { idSchema } from "./id.js";
import { Money } from "./money.js";
import { Timestamp } from "./time.js";

export const OrderStatus = z.enum(["draft", "open", "completed", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const PaymentStatus = z.enum([
  "unpaid",
  "requires_action",
  "pending",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

/** Derived from line fulfilment; never set directly. */
export const FulfilmentStatus = z.enum([
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
]);
export type FulfilmentStatus = z.infer<typeof FulfilmentStatus>;

const count = z.number().int().nonnegative();

/** Snapshot of a purchased variant; later catalogue edits never alter it. `fulfilled` <= `quantity`. */
export const OrderLine = z
  .object({
    id: idSchema("line"),
    /** Needed to restock; absent on lines created before refunds existed. */
    variantId: VariantId.optional(),
    title: z.string().min(1),
    deliveryType: DeliveryType,
    quantity: count.min(1),
    fulfilled: count,
    /** Units returned to stock by refunds or cancellation; never above `quantity`. */
    restocked: count.optional(),
    unitPrice: Money,
  })
  .refine((l) => l.fulfilled <= l.quantity, {
    message: "fulfilled exceeds quantity",
  })
  .refine((l) => (l.restocked ?? 0) <= l.quantity, {
    message: "restocked exceeds quantity",
  });
export type OrderLine = z.infer<typeof OrderLine>;

/**
 * `paid` is the captured amount (0 until paid, then `total`); `refunded` never exceeds it.
 * The three statuses are independent machines; transition rules live in `@free-commerce/core`.
 */
export const Order = z
  .object({
    id: idSchema("ord"),
    number: z.number().int().positive(),
    status: OrderStatus,
    paymentStatus: PaymentStatus,
    fulfilmentStatus: FulfilmentStatus,
    lines: z.array(OrderLine).min(1),
    total: Money,
    paid: Money,
    refunded: Money,
    /** Provider payment that funded the order; refunds go through it. */
    paymentId: z.string().min(1).optional(),
    /** Idempotency keys of the admin refunds already applied (replays are no-ops). */
    refunds: z.array(z.string()).optional(),
    /** What the customer agreed to at checkout. Immediate delivery is recorded only when digital lines were bought. */
    consents: z
      .strictObject({
        termsAcceptedAt: Timestamp,
        immediateDeliveryAcceptedAt: Timestamp.optional(),
      })
      .optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine(
    (o) =>
      o.paid.currency === o.total.currency &&
      o.refunded.currency === o.total.currency,
    { message: "currency mismatch" },
  )
  .refine((o) => o.refunded.amount <= o.paid.amount, {
    message: "refunded exceeds paid",
  });
export type Order = z.infer<typeof Order>;

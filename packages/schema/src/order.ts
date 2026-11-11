import { z } from "zod";
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

export const DeliveryType = z.enum(["physical", "digital", "none"]);
export type DeliveryType = z.infer<typeof DeliveryType>;

const count = z.number().int().nonnegative();

/** Snapshot of a purchased variant; later catalogue edits never alter it. `fulfilled` <= `quantity`. */
export const OrderLine = z
  .object({
    id: idSchema("line"),
    title: z.string().min(1),
    deliveryType: DeliveryType,
    quantity: count.min(1),
    fulfilled: count,
    unitPrice: Money,
  })
  .refine((l) => l.fulfilled <= l.quantity, {
    message: "fulfilled exceeds quantity",
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

/** Notes, customer messages and status changes share one timeline. */
export const TimelineEvent = z.discriminatedUnion("kind", [
  z.object({
    id: idSchema("tl"),
    orderId: idSchema("ord"),
    at: Timestamp,
    kind: z.enum(["note", "customer_message"]),
    body: z.string().min(1),
  }),
  z.object({
    id: idSchema("tl"),
    orderId: idSchema("ord"),
    at: Timestamp,
    kind: z.literal("status_change"),
    machine: z.enum(["lifecycle", "payment", "fulfilment"]),
    from: z.string(),
    to: z.string(),
  }),
]);
export type TimelineEvent = z.infer<typeof TimelineEvent>;

import type {
  FulfilmentStatus,
  Order,
  OrderStatus,
  PaymentStatus,
} from "@free-commerce/schema";

type Machine = "lifecycle" | "payment" | "fulfilment";

type TransitionReason =
  | "not_allowed"
  | "order_not_open"
  | "payment_not_captured"
  | "not_fully_fulfilled"
  | "payment_unsettled"
  | "already_fulfilled"
  | "invalid_quantity"
  | "unknown_line"
  | "currency_mismatch"
  | "refund_exceeds_paid";

/** Returned (never thrown) when a transition is refused; names the machine and the from/to states. */
export type TransitionError = {
  machine: Machine;
  from: string;
  to: string;
  reason: TransitionReason;
};

export type Result =
  | { ok: true; order: Order }
  | { ok: false; error: TransitionError };

/** Allowed lifecycle moves. `open -> completed` is also guarded; cancellation is further guarded. */
export const LIFECYCLE_TRANSITIONS: Record<
  OrderStatus,
  readonly OrderStatus[]
> = {
  draft: ["open", "cancelled"],
  open: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Refund targets (`partially_refunded`, `refunded`) are reached only through `refundOrder`. */
export const PAYMENT_TRANSITIONS: Record<
  PaymentStatus,
  readonly PaymentStatus[]
> = {
  unpaid: ["requires_action", "pending", "paid"],
  requires_action: ["pending", "paid", "failed"],
  pending: ["paid", "failed"],
  paid: ["partially_refunded", "refunded"],
  partially_refunded: ["partially_refunded", "refunded"],
  refunded: [],
  failed: [],
};

/** Fulfilment is derived from lines, so it only ever moves forward. */
export const FULFILMENT_TRANSITIONS: Record<
  FulfilmentStatus,
  readonly FulfilmentStatus[]
> = {
  unfulfilled: ["partially_fulfilled", "fulfilled"],
  partially_fulfilled: ["partially_fulfilled", "fulfilled"],
  fulfilled: [],
};

const fail = (
  machine: Machine,
  from: string,
  to: string,
  reason: TransitionReason,
): Result => ({
  ok: false,
  error: { machine, from, to, reason },
});

/** Money was captured: `paid` or `partially_refunded`. */
const captured = (p: PaymentStatus): boolean =>
  p === "paid" || p === "partially_refunded";

const deriveFulfilment = (lines: Order["lines"]): FulfilmentStatus => {
  if (lines.every((l) => l.fulfilled === l.quantity)) return "fulfilled";
  return lines.some((l) => l.fulfilled > 0)
    ? "partially_fulfilled"
    : "unfulfilled";
};

/**
 * Applies the automatic rules after any change: once captured, digital and `none` lines are
 * fulfilled; an open, captured, fully fulfilled order completes. Idempotent.
 */
export const settle = (order: Order): Order => {
  let lines = order.lines;
  if (captured(order.paymentStatus))
    lines = lines.map((l) =>
      l.deliveryType === "physical" ? l : { ...l, fulfilled: l.quantity },
    );
  const fulfilmentStatus = deriveFulfilment(lines);
  const done =
    order.status === "open" &&
    captured(order.paymentStatus) &&
    fulfilmentStatus === "fulfilled";
  return {
    ...order,
    lines,
    fulfilmentStatus,
    status: done ? "completed" : order.status,
  };
};

export const transitionLifecycle = (order: Order, to: OrderStatus): Result => {
  const from = order.status;
  const refuse = (reason: TransitionReason) =>
    fail("lifecycle", from, to, reason);
  if (!LIFECYCLE_TRANSITIONS[from].includes(to)) return refuse("not_allowed");
  if (to === "completed") {
    if (!captured(order.paymentStatus)) return refuse("payment_not_captured");
    if (order.fulfilmentStatus !== "fulfilled")
      return refuse("not_fully_fulfilled");
  }
  // Cancelling must not strand money or leave a fulfilled order cancelled.
  if (to === "cancelled") {
    if (!["unpaid", "failed", "refunded"].includes(order.paymentStatus))
      return refuse("payment_unsettled");
    if (order.fulfilmentStatus === "fulfilled")
      return refuse("already_fulfilled");
  }
  return { ok: true, order: { ...order, status: to } };
};

/** Non-refund payment moves. Anything past `unpaid` needs an open order. */
export const transitionPayment = (order: Order, to: PaymentStatus): Result => {
  const from = order.paymentStatus;
  const refuse = (reason: TransitionReason) =>
    fail("payment", from, to, reason);
  const viaRefund = to === "partially_refunded" || to === "refunded";
  if (viaRefund || !PAYMENT_TRANSITIONS[from].includes(to))
    return refuse("not_allowed");
  if (order.status !== "open") return refuse("order_not_open");
  const paid = to === "paid" ? order.total : order.paid;
  return { ok: true, order: settle({ ...order, paymentStatus: to, paid }) };
};

/** Records a refund of `amount` against the captured payment; never exceeds what was paid. */
export const refundOrder = (order: Order, amount: Order["paid"]): Result => {
  const from = order.paymentStatus;
  const full = order.refunded.amount + amount.amount === order.paid.amount;
  const to = full ? "refunded" : "partially_refunded";
  const refuse = (reason: TransitionReason) =>
    fail("payment", from, to, reason);
  if (!captured(from)) return refuse("not_allowed");
  if (amount.currency !== order.paid.currency)
    return refuse("currency_mismatch");
  if (!Number.isSafeInteger(amount.amount) || amount.amount <= 0)
    return refuse("invalid_quantity");
  if (order.refunded.amount + amount.amount > order.paid.amount)
    return refuse("refund_exceeds_paid");
  return {
    ok: true,
    order: {
      ...order,
      paymentStatus: to,
      refunded: {
        ...order.refunded,
        amount: order.refunded.amount + amount.amount,
      },
    },
  };
};

/** Marks `quantity` more units of each listed line fulfilled (physical lines; others settle automatically). */
export const fulfil = (
  order: Order,
  items: readonly { lineId: string; quantity: number }[],
): Result => {
  const from = order.fulfilmentStatus;
  const refuse = (reason: TransitionReason, to: string = from) =>
    fail("fulfilment", from, to, reason);
  if (order.status !== "open") return refuse("order_not_open");
  if (!captured(order.paymentStatus)) return refuse("payment_not_captured");
  if (from === "fulfilled") return refuse("already_fulfilled");
  const add = new Map<string, number>();
  for (const { lineId, quantity } of items) {
    const line = order.lines.find((l) => l.id === lineId);
    if (!line) return refuse("unknown_line");
    const next = (add.get(lineId) ?? 0) + quantity;
    if (
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      line.fulfilled + next > line.quantity
    )
      return refuse("invalid_quantity");
    add.set(lineId, next);
  }
  if (add.size === 0) return refuse("invalid_quantity");
  const lines = order.lines.map((l) => ({
    ...l,
    fulfilled: l.fulfilled + (add.get(l.id) ?? 0),
  }));
  return { ok: true, order: settle({ ...order, lines }) };
};

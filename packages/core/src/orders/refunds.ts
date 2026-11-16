import {
  type Money,
  Order,
  toTimestamp,
  type Variant,
} from "@free-commerce/schema";
import { type AuditEntry, newAuditEntry } from "../access/access";
import type { PaymentProvider } from "../providers/payment";
import type { Database, Repositories } from "../repositories";
import { refundOrder, transitionLifecycle } from "./machines";

/** @experimental `refused`: an order rule said no (`detail` is its reason); `refund_failed`: the provider declined. */
export class RefundError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "no_payment"
      | "invalid_restock"
      | "refund_failed"
      | "key_reused"
      | "refused",
    readonly detail: string,
    cause?: unknown,
  ) {
    super(`${code}: ${detail}`, { cause });
    this.name = "RefundError";
  }
}

/** @experimental */
export interface RefundDeps {
  db: Database;
  payments: PaymentProvider;
  variantOf(variantId: string): Promise<Variant | null>;
  /** Revokes the order's download grants inside the refund transaction (task 2.10); must be idempotent. */
  revokeDownloads?(tx: Repositories, order: Order): Promise<void>;
  now?: () => Date;
}

/** @experimental `key` identifies this admin action: replaying it applies nothing twice. */
export interface RefundInput {
  orderId: string;
  key: string;
  actor: AuditEntry["actor"];
  /** Minor units; omitted means everything still refundable. Not allowed with `cancel`. */
  amount?: number;
  /** Refunds the remainder and cancels the order. */
  cancel?: boolean;
  /** Units to put back on the shelf, per order line (managed variants only). */
  restock?: { lineId: string; quantity: number }[];
}

/** What a key was used for; the same key with different content is a caller bug, not a replay. */
const fingerprint = (i: RefundInput) =>
  JSON.stringify([i.key, i.amount ?? null, !!i.cancel, i.restock ?? []]);

/** The order if `input` replays an applied action, `null` if the key is new; throws if the key was used differently. */
function replayOf(order: Order, input: RefundInput) {
  const prior = order.refunds?.find((f) => f.startsWith(`["${input.key}",`));
  if (!prior) return null;
  if (prior !== fingerprint(input))
    throw new RefundError("key_reused", input.key);
  return order;
}

/** A given amount is a positive whole number and never combined with `cancel`, which refunds the remainder. */
function assertAmount({ amount, cancel }: RefundInput) {
  if (amount === undefined) return;
  if (cancel) throw new RefundError("refused", "amount_with_cancel");
  if (!(Number.isSafeInteger(amount) && amount > 0))
    throw new RefundError("refused", "invalid_amount");
}

type Plan = Map<string, number>;

/**
 * @experimental Admin refunds and cancellations. Validates everything first, asks the provider (idempotent by
 * key, so a retry after a later failure reuses the same refund), then applies order, stock, audit and
 * outbox in one transaction. Whatever fails leaves the order untouched and the same call can be retried.
 */
export function createRefunds(d: RefundDeps) {
  const now = d.now ?? (() => new Date());

  /** Variant ids to restock, refusing anything that is not a managed, returnable line quantity. */
  async function planRestock(order: Order, input: RefundInput) {
    const plan: Plan = new Map();
    for (const { lineId, quantity } of input.restock ?? []) {
      const line = order.lines.find((l) => l.id === lineId);
      const next = (plan.get(lineId) ?? 0) + quantity;
      if (
        !line?.variantId ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        (line.restocked ?? 0) + next > line.quantity ||
        !(await d.variantOf(line.variantId))?.manageInventory
      )
        throw new RefundError("invalid_restock", lineId);
      plan.set(lineId, next);
    }
    return plan;
  }

  /** Asks the provider; idempotent by key, so a retry after a later failure reuses the same refund. */
  async function moveMoney(order: Order, key: string, money: Money) {
    if (!order.paymentId) throw new RefundError("no_payment", order.id);
    const r = await d.payments
      .refund({
        idempotencyKey: `${order.id}:refund:${key}`,
        paymentId: order.paymentId,
        amount: money,
      })
      .catch((e: unknown) => {
        throw new RefundError("refund_failed", String(e), e);
      });
    if (r.state === "failed") throw new RefundError("refund_failed", r.id);
  }

  /** The order after the refund/cancel, or the refusal. Pure. */
  function apply(order: Order, input: RefundInput, money: Money | null) {
    let next = order;
    if (money) {
      const r = refundOrder(next, money);
      if (!r.ok) throw new RefundError("refused", r.error.reason);
      next = r.order;
    }
    if (input.cancel) {
      const r = transitionLifecycle(next, "cancelled");
      if (!r.ok) throw new RefundError("refused", r.error.reason);
      next = r.order;
    }
    return next;
  }

  /** Stock back on the shelf, per the validated plan, inside the transaction. */
  async function restock(tx: Repositories, order: Order, plan: Plan) {
    for (const [lineId, quantity] of plan) {
      const variantId = order.lines.find((l) => l.id === lineId)
        ?.variantId as string;
      const stock = await tx.inventory.getStock(variantId);
      await tx.inventory.setStock({
        variantId,
        quantity: (stock?.quantity ?? 0) + quantity,
      });
    }
  }

  /** Order, stock, outbox, audit and download revocation in one transaction; idempotent by `input.key`. */
  async function commit(
    tx: Repositories,
    input: RefundInput,
    money: Money | null,
    plan: Plan,
  ) {
    const fresh = (await tx.orders.get(input.orderId)) as Order;
    const replay = replayOf(fresh, input);
    if (replay) return replay;
    const at = toTimestamp(now());
    const next = Order.parse({
      ...apply(fresh, input, money),
      lines: fresh.lines.map((l) => ({
        ...l,
        restocked: (l.restocked ?? 0) + (plan.get(l.id) ?? 0),
      })),
      refunds: [...(fresh.refunds ?? []), fingerprint(input)],
      updatedAt: at,
    });
    await restock(tx, fresh, plan);
    await tx.orders.save(next);
    const type = input.cancel ? "order.cancelled" : "order.refunded";
    await tx.outbox.add({
      id: `${next.id}:${type}:${input.key}`,
      type,
      occurredAt: at,
      payload: { orderId: next.id, amount: money?.amount ?? 0 },
    });
    const view = (o: Order) => ({
      paymentStatus: o.paymentStatus,
      status: o.status,
      refunded: o.refunded.amount,
    });
    await tx.audit.append(
      newAuditEntry(
        {
          actor: input.actor,
          action: `POST /admin/orders/:id/${input.cancel ? "cancel" : "refund"}`,
          target: `orders/${next.id}`,
          before: view(fresh),
          after: view(next),
        },
        Date.parse(at),
      ),
    );
    if (next.paymentStatus === "refunded" || next.status === "cancelled")
      await d.revokeDownloads?.(tx, next);
    return next;
  }

  return {
    /** Returns the updated order; a replayed `key` returns it unchanged. */
    async refund(input: RefundInput): Promise<Order> {
      assertAmount(input);
      const order = (await d.db.orders.get(input.orderId)) as Order | null;
      if (!order) throw new RefundError("not_found", input.orderId);
      const replay = replayOf(order, input);
      if (replay) return replay;
      const sum = input.amount ?? order.paid.amount - order.refunded.amount;
      if (sum === 0 && !input.cancel)
        throw new RefundError("refused", "nothing_to_refund");
      const money =
        sum > 0 ? { amount: sum, currency: order.paid.currency } : null;
      const plan = await planRestock(order, input);
      apply(order, input, money); // refuse before any money moves
      if (money) await moveMoney(order, input.key, money);
      return d.db.transaction((tx) => commit(tx, input, money, plan));
    },
  };
}

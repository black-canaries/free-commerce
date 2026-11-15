import {
  type Cart,
  type CartLine,
  idSchema,
  Money,
  Order,
  Timestamp,
  toTimestamp,
  type Variant,
} from "@free-commerce/schema";
import { z } from "zod";
import { getCart } from "../cart/cart";
import { redeemDiscount, releaseDiscount } from "../discounts/discounts";
import { createInventory } from "../inventory/inventory";
import { settle } from "../orders/machines";
import { ProviderError } from "../providers/error";
import type {
  Payment,
  PaymentEvent,
  PaymentProvider,
} from "../providers/payment";
import type { Database, Repositories } from "../repositories";
import {
  createSagaRunner,
  type Saga,
  type SagaStore,
  type Tracer,
} from "./runner";

/** @experimental `runId` is `chk_...`, one per checkout attempt; callers map their HTTP idempotency key to it. */
export const CheckoutInput = z.strictObject({
  cartId: idSchema("cart"),
  /** `Cart.updatedAt` at the time `total` was computed; a cart edited since is refused. */
  cartUpdatedAt: Timestamp,
  /** What the customer pays, from `cartTotals`. */
  total: Money,
  consents: z.strictObject({
    termsAcceptedAt: Timestamp,
    /** Required when the cart has digital lines. */
    immediateDeliveryAcceptedAt: Timestamp.optional(),
  }),
  discount: z
    .strictObject({
      codeId: z.string().min(1),
      customerKey: z.string().optional(),
    })
    .optional(),
});
/** @experimental */
export type CheckoutInput = z.infer<typeof CheckoutInput>;

/** @experimental A rule refused the checkout; the saga records it as the run's `error` and compensates. */
export class CheckoutError extends Error {
  constructor(
    readonly code:
      | "cart_changed"
      | "consent_required"
      | "out_of_stock"
      | "payment_not_captured"
      | "reservation_lost"
      | "unknown_variant",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CheckoutError";
  }
}

/** @experimental */
export interface CheckoutDeps {
  db: Database;
  payments: PaymentProvider;
  store: SagaStore;
  variantOf(variantId: string): Promise<Variant | null>;
  /** The app's index from provider payment id to saga run id (webhooks carry only the payment id). */
  runIdOf(paymentId: string): Promise<string | null>;
  /** Next gap-free order number; runs inside the order transaction, so use `tx`, never the outer repositories. */
  nextOrderNumber(tx: Repositories): Promise<number>;
  /** Creates download grants for a paid order's digital lines, inside the order transaction (task 2.10). */
  grantDownloads?(tx: Repositories, order: Order): Promise<void>;
  now?: () => Date;
  tracer?: Tracer;
}

const runOf = (key: string) => key.slice(0, key.indexOf(":"));
const WAIT_MS = 30 * 60_000;
const HOLD_MS = WAIT_MS + 5 * 60_000;
const EVENT = "payment.settled";
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic id from the run id, so a re-driven step finds its own rows. `i` < 1024 tells siblings apart. */
const derive = (prefix: string, runId: string, i = 0) =>
  `${prefix}${runId.slice(runId.indexOf("_"), -2)}${BASE32[i >> 5]}${BASE32[i & 31]}`;

interface Reserved {
  lines: CartLine[];
  currency: string;
  /** Reservation ids, one per managed line. */
  holds: string[];
}

/** Refuses a cart edited since pricing, or digital lines without the immediate-delivery consent. */
function assertCheckoutable(cart: Cart, input: CheckoutInput) {
  if (cart.updatedAt !== input.cartUpdatedAt)
    throw new CheckoutError("cart_changed", "cart was edited");
  if (
    cart.lines.some((l) => l.deliveryType === "digital") &&
    !input.consents.immediateDeliveryAcceptedAt
  )
    throw new CheckoutError("consent_required", "immediate delivery");
}

function assertPaid(p: Payment, total: Money) {
  if (
    p.state !== "captured" ||
    p.amount.amount !== total.amount ||
    p.amount.currency !== total.currency
  )
    throw new CheckoutError("payment_not_captured", p.state);
}

/** The paid order for a reserved cart; `settle` fulfils digital and `none` lines. */
function buildOrder(
  id: string,
  number: number,
  at: string,
  input: CheckoutInput,
  reserved: Reserved,
  paymentId: string,
): Order {
  const { currency } = reserved;
  return Order.parse(
    settle({
      id,
      number,
      status: "open",
      paymentStatus: "paid",
      fulfilmentStatus: "unfulfilled",
      lines: reserved.lines.map((l) => ({
        id: l.id,
        title: l.title,
        deliveryType: l.deliveryType,
        quantity: l.quantity,
        fulfilled: 0,
        unitPrice: { amount: l.unitPrice, currency },
      })),
      total: input.total,
      paid: input.total,
      refunded: { amount: 0, currency },
      paymentId,
      consents: input.consents,
      createdAt: at,
      updatedAt: at,
    }),
  );
}

/**
 * @experimental The `completeCheckout` saga (ADR 0026): reserve, redeem discount, create payment, wait
 * for it to settle, then one transaction creates the order. Returns the entry points the API calls.
 */
export function createCheckout(d: CheckoutDeps) {
  const { db, payments } = d;
  const now = d.now ?? (() => new Date());
  const inventory = createInventory(db.inventory, now);
  const holdIds = (cart: Pick<Cart, "lines">, runId: string) =>
    cart.lines.map((_, i) => derive("rsv", runId, i));
  const payInput = (key: string, input: CheckoutInput) => ({
    idempotencyKey: key,
    amount: input.total,
    reference: input.cartId,
  });
  const refund = (key: string, p: Payment) =>
    payments.refund({ idempotencyKey: key, paymentId: p.id, amount: p.amount });

  /** One transaction: commit stock, save the order, queue its events, grant downloads. Idempotent by order id. */
  async function placeOrder(
    tx: Repositories,
    id: string,
    input: CheckoutInput,
    reserved: Reserved,
    paymentId: string,
  ) {
    if (await tx.orders.get(id)) return { orderId: id };
    const stock = createInventory(tx.inventory, now);
    for (const hold of reserved.holds)
      if (!(await stock.commit(hold)).ok)
        throw new CheckoutError("reservation_lost", hold);
    const at = toTimestamp(now());
    const number = await d.nextOrderNumber(tx);
    const order = buildOrder(id, number, at, input, reserved, paymentId);
    await tx.orders.save(order);
    for (const type of ["order.created", "order.paid"])
      await tx.outbox.add({
        id: `${id}:${type}`,
        type,
        occurredAt: at,
        payload: { orderId: id },
      });
    await d.grantDownloads?.(tx, order);
    return { orderId: id };
  }

  /** Same-key replay finds a payment whose creation was ambiguous. A definite refusal means none exists. */
  const recover = (key: string, input: CheckoutInput) =>
    payments.createPayment(payInput(key, input)).catch((e: unknown) => {
      if (e instanceof ProviderError && e.retryable) throw e;
      return null;
    });

  const saga: Saga<CheckoutInput> = {
    name: "completeCheckout",
    steps: [
      {
        name: "reserve-stock",
        run: async (c): Promise<Reserved> => {
          const { input } = c;
          const runId = runOf(c.key);
          const cart = await getCart(db.carts, input.cartId);
          assertCheckoutable(cart, input);
          const holds: string[] = [];
          for (const [i, line] of cart.lines.entries()) {
            const variant = await d.variantOf(line.variantId);
            if (!variant)
              throw new CheckoutError("unknown_variant", line.variantId);
            const out = await inventory.reserve({
              variant,
              cartId: cart.id,
              quantity: line.quantity,
              ttlMs: HOLD_MS,
              id: derive("rsv", runId, i),
            });
            if (out.status === "unmanaged") continue;
            if (out.status !== "reserved")
              throw new CheckoutError("out_of_stock", line.variantId);
            holds.push(out.reservation.id);
          }
          return { lines: cart.lines, currency: cart.currency, holds };
        },
        // Ambiguous failure: the cart tells which ids may exist; releasing an unknown id is a no-op.
        compensate: async (c, r) => {
          const runId = runOf(c.key);
          const ids =
            (r as Reserved | undefined)?.holds ??
            holdIds((await db.carts.get(c.input.cartId)) as Cart, runId);
          for (const id of ids) await inventory.release(id);
        },
      },
      {
        name: "redeem-discount",
        run: async (c) => {
          const { discount } = c.input;
          if (!discount) return null;
          const code = await db.discounts.get(discount.codeId);
          if (!code)
            throw new CheckoutError("unknown_variant", "discount code");
          await redeemDiscount(
            db.discounts,
            code,
            runOf(c.key),
            discount.customerKey,
          );
          return null;
        },
        compensate: (c) => releaseDiscount(db.discounts, runOf(c.key)),
      },
      {
        name: "create-payment",
        retries: 2,
        run: async (c) => {
          const p = await payments.createPayment(payInput(c.key, c.input));
          return { id: p.id };
        },
        // No void in the provider interface: only captured money is undone. A payment still open is
        // refused later by `onPaymentEvent`. With no recorded id the same-key call recovers the payment.
        compensate: async (c, r) => {
          const id = (r as { id: string } | undefined)?.id;
          const p = await (id
            ? payments.retrieve(id)
            : recover(c.key.replace(/:compensate$/, ""), c.input));
          if (!p) return;
          if (p.state === "captured") await refund(c.key, p);
        },
      },
      { name: "await-payment", waitFor: { event: EVENT, timeoutMs: WAIT_MS } },
      {
        name: "create-order",
        run: async (c) => {
          const runId = runOf(c.key);
          const { input } = c;
          const reserved = c.results["reserve-stock"] as Reserved;
          const { id: paymentId } = c.results["create-payment"] as {
            id: string;
          };
          // The webhook only triggers this step; the provider's current state is the truth.
          const p = await payments.retrieve(paymentId);
          assertPaid(p, input.total);
          return db.transaction((tx) =>
            placeOrder(tx, derive("ord", runId), input, reserved, paymentId),
          );
        },
        // Atomic: a failure leaves no order, grant, event or stock change; the payment step refunds.
      },
    ],
  };

  const runner = createSagaRunner({
    store: d.store,
    tracer: d.tracer,
    now: () => now().getTime(),
  });

  /** Delivers a verified, terminal payment state to run `runId`; refunds money that arrives after the run gave up. */
  async function settleRun(runId: string, event: PaymentEvent) {
    const run = await runner.resume(saga, runId, EVENT, { eventId: event.id });
    // Same key and amount as the compensation refund, so replays and duplicates collapse.
    if (
      event.payment.state === "captured" &&
      (run.status === "compensated" || run.status === "compensation_failed")
    )
      await refund(`${runId}:create-payment:compensate`, event.payment);
    return run;
  }

  /** Repairs a lost webhook: if the provider already settled the payment, resumes the paused run. */
  async function reconcile(runId: string) {
    const run = await d.store.load(runId);
    const paymentId = (
      run?.steps["create-payment"]?.result as { id: string } | undefined
    )?.id;
    if (run?.status !== "paused" || !paymentId) return run;
    const payment = await payments.retrieve(paymentId);
    return payment.state === "captured" || payment.state === "failed"
      ? settleRun(runId, {
          id: `reconcile:${payment.id}:${payment.state}`,
          payment,
        })
      : run;
  }

  return {
    saga,
    /**
     * Starts or re-drives checkout attempt `runId`. Returns the run: `paused` while the customer
     * authenticates (fetch the action with `payments.retrieve`), `completed` with `steps["create-order"]`,
     * or `compensated` with `error`. Calling again with the same id and input never creates a second order.
     */
    async start(runId: string, input: CheckoutInput) {
      idSchema("chk").parse(runId);
      const run = await runner.start(saga, runId, CheckoutInput.parse(input));
      return run.status === "paused" ? ((await reconcile(runId)) ?? run) : run;
    },
    /** Webhook entry (after `verifyWebhook`). Duplicate, unknown or non-terminal events return `null`. */
    async onPaymentEvent(event: PaymentEvent) {
      const { state, id } = event.payment;
      if (state !== "captured" && state !== "failed") return null;
      const runId = await d.runIdOf(id);
      return runId ? settleRun(runId, event) : null;
    },
    reconcile,
    /** Sweeper hook: compensates a run paused past its deadline, releasing stock. */
    expire: (runId: string) => runner.expire(saga, runId),
  };
}

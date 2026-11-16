import {
  type Cart,
  type CartLine,
  idSchema,
  type Money,
  Order,
  Timestamp,
  toTimestamp,
  type Variant,
} from "@free-commerce/schema";
import { z } from "zod";
import { cartTotals, getCart } from "../cart/cart";
import {
  applyDiscount,
  redeemDiscount,
  releaseDiscount,
} from "../discounts/discounts";
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

const minor = z.number().int().nonnegative();

/**
 * @experimental There is no caller-supplied total: the saga prices the cart itself (`cartTotals`, plus the
 * discount code). `adjustments` are the server-resolved shipping and tax amounts for this cart; never
 * pass values from the client. `attempt` starts at 0; a retry after a failed attempt uses the next number.
 */
export const CheckoutInput = z.strictObject({
  cartId: idSchema("cart"),
  /** `Cart.updatedAt` when the customer saw the prices; a cart edited since is refused. */
  cartUpdatedAt: Timestamp,
  attempt: z.number().int().min(0).max(1023).default(0),
  adjustments: z
    .strictObject({
      shipping: minor.optional(),
      tax: minor.optional(),
      taxIncluded: z.boolean().optional(),
    })
    .optional(),
  consents: z.strictObject({
    termsAcceptedAt: Timestamp,
    /** Required when the cart has digital lines. */
    immediateDeliveryAcceptedAt: Timestamp.optional(),
  }),
  discount: z
    .strictObject({
      code: z.string().min(1),
      customerKey: z.string().optional(),
    })
    .optional(),
});
/** @experimental */
export type CheckoutInput = z.input<typeof CheckoutInput>;

/** @experimental A rule refused the checkout; the saga records it as the run's `error` and compensates. */
export class CheckoutError extends Error {
  constructor(
    readonly code:
      | "attempt_in_progress"
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

/** Run id of attempt `n` for a cart: the cart's id body with the attempt in the last two characters. */
const runIdFor = (cartId: string, attempt = 0) =>
  `chk_${cartId.slice(5, 29)}${BASE32[attempt >> 5]}${BASE32[attempt & 31]}`;

/** Deterministic id from the run id, so a re-driven step finds its own rows. `i` < 1024 tells siblings apart. */
const derive = (prefix: string, runId: string, i = 0) =>
  `${prefix}_${runId.slice(4, 24)}${BASE32[i >> 5]}${BASE32[i & 31]}${runId.slice(26)}`;

interface Reserved {
  lines: CartLine[];
  currency: string;
  /** What the customer pays, computed here from the cart. */
  total: Money;
  discountId?: string;
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

/** The customer's total from the cart, the discount code and the server-resolved shipping and tax. */
async function priceCart(
  d: CheckoutDeps,
  cart: Cart,
  input: CheckoutInput,
  at: Date,
) {
  const { discount } = input;
  const effect = discount
    ? await applyDiscount(
        d.db.discounts,
        cart,
        discount.code,
        at,
        discount.customerKey,
      )
    : undefined;
  const { shipping, ...rest } = input.adjustments ?? {};
  const { total } = cartTotals(cart, {
    ...rest,
    discount: effect?.amount,
    shipping: effect?.freeShipping ? 0 : shipping,
  });
  return { total, discountId: effect?.code.id };
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
        variantId: l.variantId,
        title: l.title,
        deliveryType: l.deliveryType,
        quantity: l.quantity,
        fulfilled: 0,
        unitPrice: { amount: l.unitPrice, currency },
      })),
      total: reserved.total,
      paid: reserved.total,
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
  const price = (cart: Cart, input: CheckoutInput) =>
    priceCart(d, cart, input, now());
  const holdIds = (lines: unknown[], runId: string) =>
    lines.map((_, i) => derive("rsv", runId, i));
  const payInput = (key: string, cartId: string, amount: Money) => ({
    idempotencyKey: key,
    amount,
    reference: cartId,
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
  const recover = (key: string, cartId: string, amount: Money) =>
    payments
      .createPayment(payInput(key, cartId, amount))
      .catch((e: unknown) => {
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
          const { total, discountId } = await price(cart, input);
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
          return {
            lines: cart.lines,
            currency: cart.currency,
            total,
            discountId,
            holds,
          };
        },
        // Ambiguous failure: the cart tells which ids may exist; releasing an unknown id is a no-op.
        compensate: async (c, r) => {
          const runId = runOf(c.key);
          const ids =
            (r as Reserved | undefined)?.holds ??
            holdIds(
              ((await db.carts.get(c.input.cartId)) as Cart | null)?.lines ??
                [],
              runId,
            );
          for (const id of ids) await inventory.release(id);
        },
      },
      {
        name: "redeem-discount",
        run: async (c) => {
          const { discountId } = c.results["reserve-stock"] as Reserved;
          const code = discountId && (await db.discounts.get(discountId));
          if (!code) return null;
          await redeemDiscount(
            db.discounts,
            code,
            runOf(c.key),
            c.input.discount?.customerKey,
          );
          return null;
        },
        compensate: (c) => releaseDiscount(db.discounts, runOf(c.key)),
      },
      {
        name: "create-payment",
        retries: 2,
        run: async (c) => {
          const { total } = c.results["reserve-stock"] as Reserved;
          const p = await payments.createPayment(
            payInput(c.key, c.input.cartId, total),
          );
          return { id: p.id };
        },
        // No void in the provider interface: only captured money is undone. A payment still open is
        // refused later by `onPaymentEvent`. With no recorded id the same-key call recovers the payment.
        compensate: async (c, r) => {
          const id = (r as { id: string } | undefined)?.id;
          const { total } = c.results["reserve-stock"] as Reserved;
          const p = await (id
            ? payments.retrieve(id)
            : recover(
                c.key.replace(/:compensate$/, ""),
                c.input.cartId,
                total,
              ));
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
          assertPaid(p, reserved.total);
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

  /** Refunds money captured after (or while) the run gave up; same key and amount as the compensation refund, so replays collapse. */
  const refundLate = (runId: string, p: Payment) =>
    refund(`${runId}:create-payment:compensate`, p);
  const gaveUp = (status: string) =>
    status === "compensating" ||
    status === "compensated" ||
    status === "compensation_failed";

  /** Delivers a verified, terminal payment state to run `runId`; refunds money that arrives after the run gave up. */
  async function settleRun(runId: string, event: PaymentEvent) {
    const run = await runner.resume(saga, runId, EVENT, { eventId: event.id });
    if (event.payment.state === "captured" && gaveUp(run.status))
      await refundLate(runId, event.payment);
    return run;
  }

  /**
   * Safety net for lost webhooks (sweeper, task 2.11): resumes a paused run whose payment settled, and
   * refunds the payment of a run that already gave up if it was captured after all.
   */
  async function reconcile(runId: string) {
    const run = await d.store.load(runId);
    const paymentId = (
      run?.steps["create-payment"]?.result as { id: string } | undefined
    )?.id;
    const paused = run?.status === "paused";
    if (!run || !paymentId || !(paused || gaveUp(run.status))) return run;
    const p = await payments.retrieve(paymentId);
    if (!paused) {
      if (p.state === "captured") await refundLate(runId, p);
      return run;
    }
    const event = { id: `reconcile:${p.id}:${p.state}`, payment: p };
    return p.state === "captured" || p.state === "failed"
      ? settleRun(runId, event)
      : run;
  }

  return {
    saga,
    /** Run id of attempt `attempt` for a cart; use it with `reconcile` and `expire`. */
    runIdFor,
    /**
     * Starts or re-drives the checkout attempt of `input.cartId`. The run id derives from the cart and
     * attempt, so a double submit or second tab is the same run (one payment, one order). A later attempt
     * needs the previous one to have been compensated. Returns the run: `paused` while the customer
     * authenticates (fetch the action with `payments.retrieve`), `completed` with `steps["create-order"]`,
     * or `compensated` with `error`.
     *
     * Ordering: record the payment-id to run-id mapping (`runIdOf`) right after this returns; a webhook
     * that wins the race is dropped, and calling `start` again (or `reconcile`) repairs it.
     */
    async start(raw: CheckoutInput) {
      const input = CheckoutInput.parse(raw);
      const runId = runIdFor(input.cartId, input.attempt);
      if (input.attempt > 0) {
        const prev = await d.store.load(
          runIdFor(input.cartId, input.attempt - 1),
        );
        if (prev?.status !== "compensated")
          throw new CheckoutError(
            "attempt_in_progress",
            `attempt ${input.attempt - 1}`,
          );
      }
      const run = await runner.start(saga, runId, input);
      return run.status === "paused" ? ((await reconcile(runId)) ?? run) : run;
    },
    /** Webhook entry (after `verifyWebhook`). Duplicate, unknown or non-terminal events return `null`. `failed` is final for the run: a customer retrying the same payment later gets a refund, not an order. */
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

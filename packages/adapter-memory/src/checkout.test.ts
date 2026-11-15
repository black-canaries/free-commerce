import {
  createCheckout,
  createInventory,
  type PaymentProvider,
  ProviderError,
} from "@free-commerce/core";
import {
  createFakePayments,
  createFakeSagaStore,
  FAKE_TOKENS,
} from "@free-commerce/core/testing";
import {
  type Cart,
  type DiscountCode,
  newId,
  type Order,
  type Variant,
} from "@free-commerce/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "./index";

const START = Date.parse("2026-06-01T00:00:00.000Z");
const MIN = 60_000;
type Point =
  | "none"
  | "reserve"
  | "payment"
  | "payment-ambiguous"
  | "declined"
  | "order"
  | "timeout";

function world(
  opts: { qty?: number; price?: number; point?: Point; code?: boolean } = {},
) {
  const { qty = 2, price = 1500, point = "none" } = opts;
  const db = createMemoryDatabase();
  const fake = createFakePayments();
  let t = START;
  const now = () => new Date(t);
  const ids = { phys: newId("var"), dig: newId("var") };
  const variants = new Map(
    Object.values(ids).map((id) => [
      id,
      {
        id,
        manageInventory: id === ids.phys,
        allowBackorder: false,
      } as Variant,
    ]),
  );
  const line = (variantId: string, deliveryType: string, quantity: number) => ({
    id: newId("line"),
    variantId,
    title: deliveryType,
    deliveryType,
    taxCategory: "standard",
    quantity,
    unitPrice: price,
  });
  const cart = {
    id: newId("cart"),
    currency: "USD",
    lines: [line(ids.phys, "physical", qty), line(ids.dig, "digital", 1)],
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
  } as Cart;
  const total = { amount: price * (qty + 1), currency: "USD" };

  // Failure injection and bookkeeping around the fake provider.
  const created: string[] = [];
  const refunds = new Map<string, number>();
  const payments: PaymentProvider = {
    ...fake,
    createPayment: async (i) => {
      if (point === "payment")
        throw new ProviderError("fake", "rejected", "boom");
      const p = await fake.createPayment(i);
      created.push(p.id);
      if (point === "payment-ambiguous" && created.length === 1)
        throw new ProviderError("fake", "rejected", "timeout after create");
      return p;
    },
    refund: async (i) => {
      const r = await fake.refund(i);
      refunds.set(r.id, r.amount.amount);
      return r;
    },
  };
  const runs = new Map<string, string>();
  let orderNo = 0;
  const checkout = createCheckout({
    db,
    payments,
    store: createFakeSagaStore(),
    now,
    variantOf: async (id) => {
      if (point === "reserve") throw new Error("catalog down");
      return variants.get(id) ?? null;
    },
    runIdOf: async (id) => runs.get(id) ?? null,
    nextOrderNumber: async () => {
      if (point === "order") throw new Error("number allocator down");
      return ++orderNo;
    },
  });
  const runId = newId("chk");
  const input = {
    cartId: cart.id,
    cartUpdatedAt: cart.updatedAt,
    total,
    consents: {
      termsAcceptedAt: new Date(START).toISOString(),
      immediateDeliveryAcceptedAt: new Date(START).toISOString(),
    },
    ...(opts.code && {
      discount: { codeId: "disc_00000000000000000000000000", customerKey: "a" },
    }),
  };

  const w = {
    db,
    fake,
    cart,
    total,
    runId,
    input,
    checkout,
    created,
    advance: (ms: number) => {
      t += ms;
    },
    async setup() {
      await db.carts.save(cart);
      await createInventory(db.inventory, now).setStock(ids.phys, 10);
      if (opts.code)
        await db.discounts.save({
          id: "disc_00000000000000000000000000",
          code: "SAVE",
          active: true,
          type: "percentage",
          basisPoints: 1000,
          usageLimit: 1,
        } as DiscountCode);
      return w;
    },
    async start(over: Partial<typeof input> = {}) {
      const run = await checkout.start(runId, { ...input, ...over });
      const id = (run.steps["create-payment"]?.result as { id: string })?.id;
      if (id) runs.set(id, runId);
      return run;
    },
    paymentId: () => created[0] as string,
    confirm: (token: string) =>
      fake.confirm({
        idempotencyKey: "confirm",
        paymentId: created[0] as string,
        methodToken: token,
      }),
    /** A verified webhook delivery for the payment's current state. */
    async deliver() {
      const d = fake.delivery(created[0] as string);
      return checkout.onPaymentEvent(
        await fake.verifyWebhook(d.rawBody, d.headers),
      );
    },
    orders: async () => (await db.orders.list({ limit: 100 })).items as Order[],
    available: () => createInventory(db.inventory, now).available(ids.phys),
    onHand: async () => (await db.inventory.getStock(ids.phys))?.quantity,
    outbox: async () => (await db.outbox.pending(100)).map((e) => e.type),
    refunded: () => [...refunds.values()].reduce((a, b) => a + b, 0),
    async captured() {
      let sum = 0;
      for (const id of created) {
        const p = await fake.retrieve(id);
        if (p.state === "captured") sum += p.amount.amount;
      }
      return sum;
    },
    redemptions: async () =>
      (await db.discounts.usage("disc_00000000000000000000000000")).total,
  };
  return w;
}

type World = ReturnType<typeof world>;

/** Drives a world to its end for the injected failure point. */
async function drive(w: World, point: Point) {
  let run = await w.start();
  if (run.status !== "paused") return run;
  if (point === "timeout") {
    await w.confirm(FAKE_TOKENS.threeDs);
    w.advance(31 * MIN);
    run = await w.checkout.expire(w.runId);
    w.fake.resolve(w.paymentId(), "success"); // customer finishes 3DS too late
    await w.deliver();
    return run;
  }
  await w.confirm(point === "declined" ? FAKE_TOKENS.declined : FAKE_TOKENS.ok);
  return (await w.deliver()) ?? run;
}

/** The end-state guarantees of the task's acceptance criteria. */
async function expectClean(w: World, status: string) {
  const orders = await w.orders();
  const events = await w.outbox();
  if (status === "completed") {
    expect(orders).toHaveLength(1);
    expect(orders[0]?.paid).toEqual(w.total);
    expect(orders[0]?.total).toEqual(w.total);
    expect(await w.captured()).toBe(w.total.amount);
    expect(w.refunded()).toBe(0);
    expect(events).toEqual(["order.created", "order.paid"]);
    expect(await w.available()).toBe(await w.onHand());
  } else {
    expect(status).toBe("compensated");
    expect(orders).toHaveLength(0);
    expect(events).toEqual([]);
    expect(await w.onHand()).toBe(10);
    expect(await w.available()).toBe(10);
    expect(w.refunded()).toBe(await w.captured()); // no orphan payment
  }
}

describe("completeCheckout", () => {
  it("failure injected at every step leaves nothing behind", async () => {
    const points: Point[] = [
      "none",
      "reserve",
      "payment",
      "payment-ambiguous",
      "declined",
      "order",
      "timeout",
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...points),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 100_000 }),
        async (point, qty, price) => {
          const w = await world({ point, qty, price }).setup();
          const run = await drive(w, point);
          await expectClean(w, point === "none" ? "completed" : "compensated");
          expect(run.status).toBe(
            point === "none" ? "completed" : "compensated",
          );
          if (point === "none") expect(await w.onHand()).toBe(10 - qty);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("creates one paid order, fulfils digital lines, records consents", async () => {
    const w = await world().setup();
    const run = await drive(w, "none");
    const [order] = await w.orders();
    expect(run.status).toBe("completed");
    expect(order?.paymentId).toBe(w.paymentId());
    expect(order?.consents?.immediateDeliveryAcceptedAt).toBeDefined();
    expect(order?.lines.map((l) => l.fulfilled)).toEqual([0, 1]);
    expect(order?.status).toBe("open");
  });

  it("pauses for 3DS, and the webhook resumes it exactly once however often it arrives", async () => {
    const w = await world().setup();
    const paused = await w.start();
    expect(paused.status).toBe("paused");
    await w.confirm(FAKE_TOKENS.threeDs);
    expect(await w.deliver()).toBeNull(); // requires_action is not terminal
    w.fake.resolve(w.paymentId(), "success");
    const first = await w.deliver();
    expect(first?.status).toBe("completed");
    await w.deliver(); // new event id, same fact
    const d = w.fake.delivery(w.paymentId());
    const event = await w.fake.verifyWebhook(d.rawBody, d.headers);
    await w.checkout.onPaymentEvent(event);
    await w.checkout.onPaymentEvent(event); // exact duplicate
    await expectClean(w, "completed");
  });

  it("settles an async payment and repairs a dropped webhook by reconciling", async () => {
    const w = await world().setup();
    await w.start();
    await w.confirm(FAKE_TOKENS.async);
    expect((await w.checkout.reconcile(w.runId))?.status).toBe("paused");
    w.fake.resolve(w.paymentId(), "success"); // webhook never delivered
    expect((await w.checkout.reconcile(w.runId))?.status).toBe("completed");
    await expectClean(w, "completed");
  });

  it("double submit with the same key creates one order; a changed input is refused", async () => {
    const w = await world().setup();
    await w.start();
    await w.start();
    await w.confirm(FAKE_TOKENS.ok);
    await w.deliver();
    expect((await w.start()).status).toBe("completed");
    expect(w.created).toHaveLength(1);
    await expectClean(w, "completed");
    await expect(
      w.start({ total: { amount: 1, currency: "USD" } }),
    ).rejects.toThrow(/different input/);
  });

  it("refuses a missing delivery consent and an edited cart before touching stock or payment", async () => {
    const w = await world().setup();
    const noConsent = await w.start({
      consents: { termsAcceptedAt: w.input.consents.termsAcceptedAt },
    } as never);
    expect(noConsent.error).toMatch(/consent_required/);
    const w2 = await world().setup();
    const edited = await w2.start({
      cartUpdatedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(edited.error).toMatch(/cart_changed/);
    for (const x of [w, w2]) {
      expect(x.created).toHaveLength(0);
      expect(await x.available()).toBe(10);
    }
  });

  it("refuses when stock is short", async () => {
    const w = await world({ qty: 11 }).setup();
    const run = await w.start();
    expect(run.error).toMatch(/out_of_stock/);
    expect(await w.available()).toBe(10);
  });

  it("redeems a discount once, and gives it back when checkout fails", async () => {
    const w = await world({ code: true, point: "order" }).setup();
    await drive(w, "order");
    expect(await w.redemptions()).toBe(0);
    const ok = await world({ code: true }).setup();
    await drive(ok, "none");
    expect(await ok.redemptions()).toBe(1);
    const late = await world({ code: true }).setup();
    await late.db.discounts.redeem("disc_00000000000000000000000000", "x");
    const run = await late.start();
    expect(run.status).toBe("compensated");
    expect(await late.available()).toBe(10);
    expect(late.created).toHaveLength(0);
  });
});

import {
  createRefunds,
  type Database,
  ProviderError,
  RefundError,
} from "@free-commerce/core";
import { createFakePayments, FAKE_TOKENS } from "@free-commerce/core/testing";
import { newId, Order, type Variant } from "@free-commerce/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const TS = "2026-06-01T00:00:00.000Z";
const actor = { type: "user", id: "usr_1" } as const;

async function world(
  make: () => Database | Promise<Database>,
  over: { qty?: number; digitalOnly?: boolean; free?: boolean } = {},
) {
  const { qty = 3, digitalOnly = false, free = false } = over;
  const db = await make();
  const fake = createFakePayments();
  const phys = newId("var");
  const dig = newId("var");
  const managed = new Set([phys]);
  const unit = 1000;
  const total = { amount: unit * (qty + 1), currency: "USD" };
  const p = await fake.createPayment({
    idempotencyKey: "pay",
    amount: total,
    reference: "x",
  });
  await fake.confirm({
    idempotencyKey: "c",
    paymentId: p.id,
    methodToken: FAKE_TOKENS.ok,
  });
  const lines = [
    {
      id: newId("line"),
      variantId: phys,
      title: "Mug",
      deliveryType: "physical" as const,
      quantity: qty,
      fulfilled: 0,
      unitPrice: { amount: unit, currency: "USD" },
    },
    {
      id: newId("line"),
      variantId: dig,
      title: "Ebook",
      deliveryType: "digital" as const,
      quantity: 1,
      fulfilled: 1,
      unitPrice: { amount: unit, currency: "USD" },
    },
  ];
  const pick = () => {
    if (free) return [lines[0]];
    return digitalOnly ? [lines[1]] : lines;
  };
  const sum = (() => {
    if (free) return { amount: 0, currency: "USD" };
    return digitalOnly ? { amount: unit, currency: "USD" } : total;
  })();
  const order = Order.parse({
    id: newId("ord"),
    number: 1,
    status: "open",
    paymentStatus: "paid",
    fulfilmentStatus: free ? "unfulfilled" : "partially_fulfilled",
    lines: pick(),
    total: sum,
    paid: sum,
    refunded: { amount: 0, currency: "USD" },
    paymentId: free ? undefined : p.id,
    createdAt: TS,
    updatedAt: TS,
  });
  await db.orders.save(order);
  await db.inventory.setStock({ variantId: phys, quantity: 5 });
  const revoked: string[] = [];
  const hooks = { failTx: 0, failRevoke: 0 };
  const flaky = {
    ...db,
    transaction: ((fn: Parameters<typeof db.transaction>[0]) =>
      db.transaction(async (tx) => {
        const out = await fn(tx);
        if (hooks.failTx-- > 0) throw new Error("commit failed");
        return out;
      })) as typeof db.transaction,
  };
  const refunds = createRefunds({
    db: flaky,
    payments: fake,
    variantOf: async (id) =>
      ({ id, manageInventory: managed.has(id) }) as Variant,
    revokeDownloads: async (_tx, o) => {
      if (hooks.failRevoke-- > 0) throw new Error("revoke failed");
      revoked.push(o.id);
    },
    now: () => new Date(TS),
  });
  const providerRefunded = async () => {
    // Refunding the rest would fail if anything were left; probe via retrieve-free arithmetic on the fake.
    return (await fake.retrieve(p.id)).amount.amount;
  };
  return {
    db,
    fake,
    order,
    phys,
    hooks,
    revoked,
    refunds,
    providerRefunded,
    line: lines[0]?.id as string,
    get: async () => (await db.orders.get(order.id)) as Order,
    stock: async () => (await db.inventory.getStock(phys))?.quantity,
    events: async () => (await db.outbox.pending(50)).map((e) => e.type),
    audits: async () => (await db.audit.list({ limit: 50 })).items.length,
    refund: (key: string, extra: object = {}) =>
      refunds.refund({ orderId: order.id, key, actor, ...extra }),
  };
}

const statusFor = (sum: number, paid: number) => {
  if (sum === 0) return "paid";
  return sum === paid ? "refunded" : "partially_refunded";
};

/** Refund and cancellation cases, registered inside `repositoryConformance` so every adapter runs them. */
export function refundCases(make: () => Database | Promise<Database>): void {
  describe("refunds", () => {
    it("partial refunds never exceed paid and the status follows the arithmetic", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 3000 }), { maxLength: 8 }),
          async (amounts) => {
            const w = await world(make);
            let sum = 0;
            for (const [i, amount] of amounts.entries()) {
              const before = await w.get();
              const res = await w
                .refund(`k${i}`, { amount })
                .then(() => true)
                .catch((e: unknown) => {
                  expect(e).toBeInstanceOf(RefundError);
                  return false;
                });
              const o = await w.get();
              if (res) sum += amount;
              else expect(o).toEqual(before); // refused: nothing changed
              expect(o.refunded.amount).toBe(sum);
              expect(sum).toBeLessThanOrEqual(o.paid.amount);
              expect(o.paymentStatus).toBe(statusFor(sum, o.paid.amount));
            }
          },
        ),
        { numRuns: 30 },
      );
    });

    it("full refund restocks, revokes grants, audits and queues an event", async () => {
      const w = await world(make);
      const o = await w.refund("k", {
        restock: [{ lineId: w.line, quantity: 2 }],
      });
      expect(o.paymentStatus).toBe("refunded");
      expect(o.refunded).toEqual(o.paid);
      expect(o.lines[0]?.restocked).toBe(2);
      expect(await w.stock()).toBe(7);
      expect(w.revoked).toEqual([o.id]);
      expect(await w.events()).toEqual(["order.refunded"]);
      expect(await w.audits()).toBe(1);
    });

    it("partial refund does not revoke grants", async () => {
      const w = await world(make);
      await w.refund("k", { amount: 500 });
      expect(w.revoked).toEqual([]);
    });

    it("cancel refunds the remainder, cancels, restocks and revokes", async () => {
      const w = await world(make);
      await w.refund("a", { amount: 1000 });
      const o = await w.refund("b", {
        cancel: true,
        restock: [{ lineId: w.line, quantity: 3 }],
      });
      expect(o.status).toBe("cancelled");
      expect(o.paymentStatus).toBe("refunded");
      expect(await w.stock()).toBe(8);
      expect(w.revoked).toEqual([o.id]);
      expect(await w.events()).toEqual(["order.refunded", "order.cancelled"]);
    });

    it("refuses to cancel a fulfilled order before any money moves", async () => {
      const w = await world(make, { digitalOnly: true });
      await expect(w.refund("k", { cancel: true })).rejects.toThrow(/refused/);
      expect(await w.get()).toEqual(w.order);
      expect((await w.fake.retrieve(w.order.paymentId as string)).state).toBe(
        "captured",
      );
      expect(await w.events()).toEqual([]);
    });

    it("replaying a key applies nothing twice", async () => {
      const w = await world(make);
      const input = {
        amount: 1000,
        restock: [{ lineId: w.line, quantity: 1 }],
      };
      const first = await w.refund("k", input);
      expect(await w.refund("k", input)).toEqual(first);
      expect(await w.stock()).toBe(6);
      expect(await w.events()).toEqual(["order.refunded"]);
      expect(await w.audits()).toBe(1);
      expect((await w.get()).refunded.amount).toBe(1000);
    });

    it.each([
      ["too much", { amount: 99_999 }],
      ["zero", { amount: 0 }],
      ["amount with cancel", { amount: 5, cancel: true }],
      ["unknown line", { restock: [{ lineId: "line_nope", quantity: 1 }] }],
      ["negative", { amount: -1 }],
    ])("refuses %s without side effects", async (_n, extra) => {
      const w = await world(make);
      await expect(w.refund("k", extra)).rejects.toBeInstanceOf(RefundError);
      expect(await w.get()).toEqual(w.order);
      expect(await w.stock()).toBe(5);
    });

    it("refuses over-restock (across refunds) and unmanaged lines, before refunding", async () => {
      const w = await world(make, { qty: 2 });
      await w.refund("a", {
        amount: 100,
        restock: [{ lineId: w.line, quantity: 2 }],
      });
      await expect(
        w.refund("b", {
          amount: 100,
          restock: [{ lineId: w.line, quantity: 1 }],
        }),
      ).rejects.toThrow(/invalid_restock/);
      const digital = w.order.lines[1]?.id as string;
      await expect(
        w.refund("c", {
          amount: 100,
          restock: [{ lineId: digital, quantity: 1 }],
        }),
      ).rejects.toThrow(/invalid_restock/);
      expect((await w.get()).refunded.amount).toBe(100);
      expect(await w.stock()).toBe(7);
    });

    it("provider refund fails: order, stock and events untouched; a retry works", async () => {
      const w = await world(make);
      w.fake.refundsAs("failed");
      await expect(
        w.refund("k", { restock: [{ lineId: w.line, quantity: 1 }] }),
      ).rejects.toThrow(/refund_failed/);
      expect(await w.get()).toEqual(w.order);
      expect(await w.stock()).toBe(5);
      expect(await w.events()).toEqual([]);
      w.fake.refundsAs("succeeded");
      expect((await w.refund("k2")).paymentStatus).toBe("refunded");
    });

    it("provider throws: nothing changes", async () => {
      const w = await world(make);
      const refunds = createRefunds({
        db: w.db,
        payments: {
          ...w.fake,
          refund: async () => {
            throw new ProviderError("fake", "unavailable", "down");
          },
        },
        variantOf: async () => null,
      });
      await expect(
        refunds.refund({ orderId: w.order.id, key: "k", actor }),
      ).rejects.toMatchObject({
        code: "refund_failed",
        cause: expect.any(ProviderError),
      });
      expect(await w.get()).toEqual(w.order);
    });

    it("restock, revoke or commit failing after the provider refunded rolls back; the retry refunds once", async () => {
      for (const fail of ["failTx", "failRevoke"] as const) {
        const w = await world(make);
        w.hooks[fail] = 1;
        await expect(
          w.refund("k", { restock: [{ lineId: w.line, quantity: 3 }] }),
        ).rejects.toThrow();
        expect(await w.get()).toEqual(w.order); // order, stock, outbox, audit all rolled back
        expect(await w.stock()).toBe(5);
        expect(await w.events()).toEqual([]);
        expect(await w.audits()).toBe(0);
        const o = await w.refund("k", {
          restock: [{ lineId: w.line, quantity: 3 }],
        });
        expect(o.refunded).toEqual(o.paid); // same provider key: money moved once
        expect(await w.stock()).toBe(8);
        expect(await w.events()).toEqual(["order.refunded"]);
      }
    });

    it("concurrent refunds with different keys never exceed paid; the same key applies once", async () => {
      const w = await world(make);
      const part = (key: string) => w.refund(key, { amount: 1500 });
      const out = await Promise.allSettled([part("a"), part("b"), part("c")]);
      expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect((await w.get()).refunded.amount).toBe(3000);
      expect(await w.audits()).toBe(2);
      const w2 = await world(make);
      await Promise.all([
        w2.refund("k", { amount: 700 }),
        w2.refund("k", { amount: 700 }),
      ]);
      expect((await w2.get()).refunded.amount).toBe(700);
      expect(await w2.audits()).toBe(1);
      expect(await w2.events()).toEqual(["order.refunded"]);
    });

    it("a reused key with different content is refused, not replayed", async () => {
      const w = await world(make);
      await w.refund("k", { amount: 100 });
      await expect(w.refund("k", { amount: 200 })).rejects.toThrow(
        /key_reused/,
      );
      expect((await w.get()).refunded.amount).toBe(100);
    });

    it("nothing left to refund is refused, and a free order can be cancelled", async () => {
      const w = await world(make);
      await w.refund("a");
      await expect(w.refund("b")).rejects.toThrow(/nothing_to_refund/);
      expect(await w.events()).toEqual(["order.refunded"]);
      const free = await world(make, { free: true });
      expect((await free.refund("c", { cancel: true })).status).toBe(
        "cancelled",
      );
    });
  });
}

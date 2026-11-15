import {
  createInventory,
  createProduct,
  type Database,
  type VariantInput,
} from "@free-commerce/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const VARIANT_ID = "var_00000000000000000000000000";
const variant = (extra: Partial<VariantInput> = {}) =>
  createProduct(
    {
      title: "Mug",
      handle: "mug",
      variants: [
        {
          id: VARIANT_ID,
          optionValues: {},
          deliveryType: "physical",
          priceMode: "fixed",
          prices: [{ currency: "USD", amount: 1200 }],
          ...extra,
        },
      ],
    },
    new Date(0),
  ).variants[0] as ReturnType<typeof createProduct>["variants"][number];

/** Fresh database with `stock` on hand and a controllable clock. */
const setup = async (make: () => Database, stock: number) => {
  let t = Date.UTC(2026, 0, 1);
  const inv = createInventory(make().inventory, () => new Date(t));
  await inv.setStock(VARIANT_ID, stock);
  return {
    inv,
    advance: (ms: number) => {
      t += ms;
    },
  };
};
const TTL = 60_000;
const hold = (
  inv: Awaited<ReturnType<typeof setup>>["inv"],
  quantity: number,
  v = variant(),
) => inv.reserve({ variant: v, cartId: "cart_1", quantity, ttlMs: TTL });
const reservedOf = async (p: ReturnType<typeof hold>) => {
  const r = await p;
  if (r.status !== "reserved")
    throw new Error(`expected reserved: ${r.status}`);
  return r.reservation;
};
const numRuns = { numRuns: 50 };

/** Inventory cases, registered inside `repositoryConformance` so every adapter runs them. */
export function inventoryCases(make: () => Database): void {
  describe("inventory", () => {
    it("holds units, rejects beyond stock, and release frees them", async () => {
      const { inv } = await setup(make, 3);
      const r = await reservedOf(hold(inv, 2));
      expect(await inv.available(VARIANT_ID)).toBe(1);
      expect((await hold(inv, 2)).status).toBe("insufficient");
      expect(await inv.release(r.id)).toMatchObject({ ok: true });
      expect(await inv.available(VARIANT_ID)).toBe(3);
      expect((await hold(inv, 3)).status).toBe("reserved");
    });

    it("commit consumes stock exactly once; repeats are safe", async () => {
      const { inv } = await setup(make, 5);
      const r = await reservedOf(hold(inv, 2));
      for (let i = 0; i < 3; i++)
        expect(await inv.commit(r.id)).toMatchObject({ ok: true });
      expect(await inv.available(VARIANT_ID)).toBe(3);
    });

    it("release is idempotent; commit and release exclude each other", async () => {
      const { inv } = await setup(make, 5);
      const a = await reservedOf(hold(inv, 1));
      await inv.release(a.id);
      expect(await inv.release(a.id)).toMatchObject({ ok: true });
      expect(await inv.commit(a.id)).toEqual({ ok: false, reason: "conflict" });
      const b = await reservedOf(hold(inv, 1));
      await inv.commit(b.id);
      expect(await inv.release(b.id)).toEqual({
        ok: false,
        reason: "conflict",
      });
      expect(await inv.available(VARIANT_ID)).toBe(4);
    });

    it("unknown reservation ids are rejected", async () => {
      const { inv } = await setup(make, 1);
      const id = "rsv_00000000000000000000000000";
      expect(await inv.commit(id)).toEqual({ ok: false, reason: "not_found" });
      expect(await inv.release(id)).toEqual({ ok: false, reason: "not_found" });
    });

    it("expired reservations stop counting, cannot commit, but can release", async () => {
      const { inv, advance } = await setup(make, 2);
      const r = await reservedOf(hold(inv, 2));
      expect(await inv.available(VARIANT_ID)).toBe(0);
      advance(TTL);
      expect(await inv.available(VARIANT_ID)).toBe(2);
      expect(await inv.commit(r.id)).toEqual({ ok: false, reason: "expired" });
      expect((await hold(inv, 2)).status).toBe("reserved");
      expect(await inv.release(r.id)).toMatchObject({ ok: true });
    });

    it("retrying a reserve with the same id returns the original", async () => {
      const { inv } = await setup(make, 2);
      const first = await reservedOf(hold(inv, 2));
      const again = await inv.reserve({
        variant: variant(),
        cartId: "cart_1",
        quantity: 2,
        ttlMs: TTL,
        id: first.id,
      });
      expect(again).toEqual({ status: "reserved", reservation: first });
      expect(await inv.available(VARIANT_ID)).toBe(0);
    });

    it("honours allowBackorder and lets committed stock go negative", async () => {
      const { inv } = await setup(make, 1);
      const v = variant({ allowBackorder: true });
      const r = await reservedOf(hold(inv, 4, v));
      expect(await inv.available(VARIANT_ID)).toBe(-3);
      await inv.commit(r.id);
      expect(await inv.available(VARIANT_ID)).toBe(-3);
    });

    it("rejects invalid quantities", async () => {
      const { inv } = await setup(make, 1);
      for (const q of [0, -1, 1.5])
        await expect(hold(inv, q)).rejects.toThrow();
    });

    it("never oversells under concurrent attempts", async () => {
      const { inv } = await setup(make, 5);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => hold(inv, 1)),
      );
      expect(results.filter((r) => r.status === "reserved")).toHaveLength(5);
      expect(await inv.available(VARIANT_ID)).toBe(0);
    });

    it("property: concurrent reservations never exceed stock", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 20 }),
          fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 15 }),
          async (stock, quantities) => {
            const { inv } = await setup(make, stock);
            const out = await Promise.all(quantities.map((q) => hold(inv, q)));
            const taken = out.reduce(
              (sum, r, i) =>
                sum + (r.status === "reserved" ? (quantities[i] ?? 0) : 0),
              0,
            );
            expect(taken).toBeLessThanOrEqual(stock);
            expect(await inv.available(VARIANT_ID)).toBe(stock - taken);
          },
        ),
        numRuns,
      );
    });

    it("property: expired reservations never count", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 10 }),
          fc.integer({ min: 0, max: 2 * TTL }),
          async (stock, quantities, wait) => {
            const { inv, advance } = await setup(make, stock);
            for (const q of quantities) await hold(inv, q);
            const before = await inv.available(VARIANT_ID);
            advance(wait);
            const after = await inv.available(VARIANT_ID);
            expect(after).toBe(wait >= TTL ? stock : before);
          },
        ),
        numRuns,
      );
    });

    it("property: repeated commits and releases settle stock exactly once", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 6 }),
          fc.array(fc.constantFrom("commit", "release"), {
            minLength: 1,
            maxLength: 8,
          }),
          async (quantity, ops) => {
            const { inv } = await setup(make, 10);
            const r = await reservedOf(hold(inv, quantity));
            for (const op of ops) await inv[op](r.id);
            const first = ops[0];
            expect(await inv.available(VARIANT_ID)).toBe(
              first === "commit" ? 10 - quantity : 10,
            );
          },
        ),
        numRuns,
      );
    });

    it("property: digital and none variants never reserve", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("digital", "none"),
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
          async (deliveryType, stock, quantity) => {
            const { inv } = await setup(make, stock);
            const v = variant({ deliveryType });
            expect(v.manageInventory).toBe(false);
            expect(await hold(inv, quantity, v)).toEqual({
              status: "unmanaged",
            });
            expect(await inv.available(VARIANT_ID)).toBe(stock);
          },
        ),
        numRuns,
      );
    });
  });
}

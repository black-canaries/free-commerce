import type { Database } from "@free-commerce/core";
import { describe, expect, it } from "vitest";

type DiscountCode = Parameters<Database["discounts"]["save"]>[0];
const code = (id: string, extra: Partial<DiscountCode> = {}): DiscountCode =>
  ({
    id: `disc_${id}`,
    code: `CODE${id}`,
    type: "free_shipping",
    active: true,
    ...extra,
  }) as DiscountCode;

/** Discount cases, registered inside `repositoryConformance` so every adapter runs them. */
export function discountCases(make: () => Database | Promise<Database>): void {
  describe("discounts", () => {
    it("finds by code and rejects a duplicate code on another id", async () => {
      const { discounts } = await make();
      await discounts.save(code("A"));
      expect(await discounts.getByCode("CODEA")).toEqual(code("A"));
      expect(await discounts.getByCode("NOPE")).toBeNull();
      await expect(
        discounts.save(code("B", { code: "CODEA" })),
      ).rejects.toThrow();
      await discounts.save(code("A", { active: false })); // same id may change
      expect((await discounts.getByCode("CODEA"))?.active).toBe(false);
    });

    it("never exceeds the usage limit under concurrent redemptions", async () => {
      const { discounts } = await make();
      await discounts.save(code("A", { usageLimit: 3 }));
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          discounts.redeem("disc_A", `ord_${i}`, `c${i}`),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(results.find((r) => !r.ok)).toEqual({
        ok: false,
        reason: "usage_limit",
      });
      expect(await discounts.usage("disc_A")).toEqual({
        total: 3,
        customer: 0,
      });
    });

    it("enforces the per-customer limit under concurrency", async () => {
      const { discounts } = await make();
      await discounts.save(code("A", { perCustomerLimit: 2 }));
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          discounts.redeem("disc_A", `ord_${i}`, i < 4 ? "ann" : "bob"),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(4);
      expect(await discounts.usage("disc_A", "ann")).toEqual({
        total: 4,
        customer: 2,
      });
      expect(await discounts.redeem("disc_A", "ord_x", "ann")).toEqual({
        ok: false,
        reason: "customer_limit",
      });
    });

    it("redeem is idempotent by redemption id; release frees the slot and is idempotent", async () => {
      const { discounts } = await make();
      await discounts.save(code("A", { usageLimit: 1 }));
      expect(await discounts.redeem("disc_A", "ord_1")).toEqual({ ok: true });
      expect(await discounts.redeem("disc_A", "ord_1")).toEqual({ ok: true });
      expect(await discounts.redeem("disc_A", "ord_2")).toEqual({
        ok: false,
        reason: "usage_limit",
      });
      await discounts.release("ord_1");
      await discounts.release("ord_1");
      expect(await discounts.redeem("disc_A", "ord_2")).toEqual({ ok: true });
    });

    it("redeeming an unknown code is not_found; redemptions roll back with the transaction", async () => {
      const db = await make();
      expect(await db.discounts.redeem("disc_none", "ord_1")).toEqual({
        ok: false,
        reason: "not_found",
      });
      await db.discounts.save(code("A", { usageLimit: 1 }));
      await expect(
        db.transaction(async (tx) => {
          await tx.discounts.redeem("disc_A", "ord_1");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.discounts.usage("disc_A")).toEqual({
        total: 0,
        customer: 0,
      });
    });
  });
}

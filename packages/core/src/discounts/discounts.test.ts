import type { Cart, DiscountCode, TaxRegion } from "@free-commerce/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cartTotals, newCart } from "../cart/cart";
import type { DiscountRepository } from "../repositories";
import { calculateTax } from "../tax/tax";
import {
  applyDiscount,
  DiscountError,
  normalizeCode,
  redeemDiscount,
  releaseDiscount,
} from "./discounts";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const cartOf = (
  prices: number[],
  type: "physical" | "digital" = "physical",
): Cart => ({
  ...newCart("EUR"),
  lines: prices.map((unitPrice, i) => ({
    id: `line_${String(i).padStart(26, "0")}`,
    variantId: `var_${String(i).padStart(26, "0")}`,
    title: "x",
    deliveryType: type,
    taxCategory: i % 2 ? "digital" : "standard",
    quantity: 1 + (i % 3),
    unitPrice,
  })),
});

const code = (extra: Record<string, unknown>): DiscountCode =>
  ({
    id: "disc_00000000000000000000000000",
    code: "SAVE",
    active: true,
    ...(extra.type ? {} : { type: "percentage", basisPoints: 1000 }),
    ...extra,
  }) as DiscountCode;

/** Minimal repo: only what `applyDiscount` reads. */
const repoOf = (
  c: DiscountCode,
  usage = { total: 0, customer: 0 },
): DiscountRepository =>
  ({
    getByCode: async (k: string) => (k === c.code ? c : null),
    usage: async () => usage,
  }) as unknown as DiscountRepository;

const reason = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof DiscountError ? e.reason : "other"),
  );

describe("applyDiscount", () => {
  const cart = cartOf([1000, 500]); // subtotal 1000 + 2*500 = 2000
  const go = (
    c: DiscountCode,
    cartArg = cart,
    usage?: { total: number; customer: number },
    key?: string,
  ) => applyDiscount(repoOf(c, usage), cartArg, " save ", NOW, key);

  it("percentage and fixed amounts, capped at the subtotal; code is case-insensitive", async () => {
    expect((await go(code({}))).amount).toBe(200);
    expect(normalizeCode(" save ")).toBe("SAVE");
    expect(
      (await go(code({ type: "fixed", amount: 700, currency: "EUR" }))).amount,
    ).toBe(700);
    expect(
      (await go(code({ type: "fixed", amount: 9999, currency: "EUR" }))).amount,
    ).toBe(2000);
  });

  it("free shipping needs a shipping cart", async () => {
    const free = code({ type: "free_shipping" });
    expect(await go(free)).toMatchObject({ amount: 0, freeShipping: true });
    expect(await reason(go(free, cartOf([100], "digital")))).toBe(
      "no_shipping",
    );
  });

  it("rejects each rule violation with its reason", async () => {
    const fixed = { type: "fixed", amount: 1, currency: "USD" };
    for (const [extra, want] of [
      [{ active: false }, "inactive"],
      [{ startsAt: "2026-07-01T00:00:00.000Z" }, "not_started"],
      [{ endsAt: "2026-06-01T00:00:00.000Z" }, "expired"],
      [{ minSubtotal: 2001 }, "min_subtotal"],
      [fixed, "currency"],
      [{ usageLimit: 5 }, "usage_limit"],
      [{ perCustomerLimit: 1 }, "customer_limit"],
    ] as const) {
      const usage = { total: 5, customer: 1 };
      expect(await reason(go(code(extra), cart, usage, "ann"))).toBe(want);
    }
    expect(
      await reason(applyDiscount(repoOf(code({})), cart, "nope", NOW)),
    ).toBe("not_found");
  });

  it("the per-customer limit needs a customer key; the window is [startsAt, endsAt)", async () => {
    const usage = { total: 0, customer: 9 };
    expect(await reason(go(code({ perCustomerLimit: 1 }), cart, usage))).toBe(
      "ok",
    );
    expect(
      await reason(
        go(
          code({
            startsAt: NOW.toISOString(),
            endsAt: "2026-06-02T00:00:00.000Z",
          }),
        ),
      ),
    ).toBe("ok");
  });

  it("property: discount never exceeds subtotal; totals never negative; tax and totals reconcile", async () => {
    const region = (inclusive: boolean): TaxRegion => ({
      country: "DE",
      inclusive,
      rates: { standard: 1900, digital: 700 },
    });
    const kinds = fc.oneof(
      fc
        .integer({ min: 1, max: 10_000 })
        .map((basisPoints) => ({ type: "percentage", basisPoints })),
      fc
        .integer({ min: 1, max: 5_000_000 })
        .map((amount) => ({ type: "fixed", amount, currency: "EUR" })),
      fc.constant({ type: "free_shipping" }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 100_000 }), {
          minLength: 1,
          maxLength: 6,
        }),
        kinds,
        fc.integer({ min: 0, max: 5000 }),
        fc.boolean(),
        async (prices, kind, ship, inclusive) => {
          const c = cartOf(prices);
          const fx = await applyDiscount(repoOf(code(kind)), c, "SAVE", NOW);
          const subtotal = c.lines.reduce(
            (s, l) => s + l.unitPrice * l.quantity,
            0,
          );
          const shipping = fx.freeShipping ? 0 : ship;
          const tax = calculateTax(c, region(inclusive), shipping, fx.amount);
          const t = cartTotals(c, {
            discount: fx.amount,
            shipping,
            tax: tax.total,
            taxIncluded: tax.inclusive,
          });
          expect(fx.amount).toBeLessThanOrEqual(subtotal);
          expect(t.discount.amount).toBe(fx.amount);
          expect(t.total.amount).toBeGreaterThanOrEqual(0);
          expect(tax.total).toBe(
            tax.lines.reduce((s, l) => s + l.tax, tax.shipping),
          );
          const net = subtotal - fx.amount;
          if (inclusive) expect(tax.total).toBeLessThanOrEqual(net + shipping);
          expect(t.total.amount).toBe(
            net + shipping + (inclusive ? 0 : tax.total),
          );
        },
      ),
    );
  });
});

describe("redeem and release", () => {
  it("delegate to the repository and map a refusal to DiscountError", async () => {
    const calls: string[] = [];
    const repo = {
      redeem: async (...a: unknown[]) => {
        calls.push(`redeem ${a.join(",")}`);
        return a[1] === "full"
          ? { ok: false, reason: "usage_limit" }
          : { ok: true };
      },
      release: async (id: string) => void calls.push(`release ${id}`),
    } as unknown as DiscountRepository;
    await redeemDiscount(repo, code({}), "ord_1", "ann");
    expect(await reason(redeemDiscount(repo, code({}), "full"))).toBe(
      "usage_limit",
    );
    await releaseDiscount(repo, "ord_1");
    expect(calls).toEqual([
      "redeem disc_00000000000000000000000000,ord_1,ann",
      "redeem disc_00000000000000000000000000,full,",
      "release ord_1",
    ]);
  });
});

describe("calculateTax with a discount", () => {
  it("taxes the discounted amounts and allocates the discount exactly", () => {
    const c = cartOf([1000, 1000]); // 1000 (std) + 2*1000 (digital)
    const r: TaxRegion = {
      country: "DE",
      inclusive: false,
      rates: { standard: 1000, digital: 1000 },
    };
    expect(calculateTax(c, r, 0, 0).total).toBe(300);
    expect(calculateTax(c, r, 0, 1500).total).toBe(150);
    expect(calculateTax(c, r, 0, 99_999).total).toBe(0); // capped at the subtotal
  });
});

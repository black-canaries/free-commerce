import { type Cart, newId } from "@free-commerce/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { newCart } from "../cart/cart";
import { ProviderError } from "./error";
import {
  createFlatRateShipping,
  createWeightBasedShipping,
  flatRateConfigSchema,
  shippingOptions,
  weightBasedConfigSchema,
} from "./shipping";
import { shippingConformance } from "./shipping.conformance";
import { createFakeShipping } from "./shipping.fake";

const cartWith = (
  deliveryType: "physical" | "digital",
  currency = "USD",
): Cart => ({
  ...newCart(currency),
  lines: [
    {
      id: newId("line"),
      variantId: newId("var"),
      title: "Thing",
      deliveryType,
      taxCategory: "standard",
      quantity: 1,
      unitPrice: 1000,
    },
  ],
});
const physical = cartWith("physical");

const tiers = [
  { upToGrams: 500, amount: 400 },
  { upToGrams: 2000, amount: 900 },
  { upToGrams: 10000, amount: 2500 },
];
const flat = { id: "std", label: "Standard", currency: "USD", amount: 500 };
const weighted = { id: "wt", label: "By weight", currency: "USD", tiers };

shippingConformance("fake", () => createFakeShipping(), "USD");
shippingConformance("flat-rate", () => createFlatRateShipping(flat), "USD");
shippingConformance(
  "weight-based",
  () => createWeightBasedShipping(weighted),
  "USD",
);

describe("shippingOptions", () => {
  it("skips the provider for carts without a physical line", async () => {
    const failing = createFakeShipping([], true);
    expect(
      await shippingOptions(failing, {
        cart: cartWith("digital"),
        weightGrams: 0,
      }),
    ).toEqual([]);
    expect(
      await shippingOptions(failing, { cart: newCart("USD"), weightGrams: 0 }),
    ).toEqual([]);
  });

  it("quotes physical carts and surfaces provider errors", async () => {
    expect(
      await shippingOptions(createFlatRateShipping(flat), {
        cart: physical,
        weightGrams: 1,
      }),
    ).toHaveLength(1);
    const err = await shippingOptions(createFakeShipping([], true), {
      cart: physical,
      weightGrams: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });
});

describe("flat rate", () => {
  it("charges the same for any weight", async () => {
    const p = createFlatRateShipping(flat);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 1_000_000 }), async (w) => {
        expect(await p.quote({ cart: physical, weightGrams: w })).toEqual([
          { id: "std", label: "Standard", amount: 500 },
        ]);
      }),
    );
  });

  it("offers nothing in another currency", async () => {
    expect(
      await createFlatRateShipping(flat).quote({
        cart: cartWith("physical", "EUR"),
        weightGrams: 1,
      }),
    ).toEqual([]);
  });

  it("rejects non-integer or negative amounts", () => {
    expect(
      flatRateConfigSchema.safeParse({ ...flat, amount: 1.5 }).success,
    ).toBe(false);
    expect(
      flatRateConfigSchema.safeParse({ ...flat, amount: -1 }).success,
    ).toBe(false);
  });
});

describe("weight based", () => {
  const p = createWeightBasedShipping(weighted);
  const price = async (w: number) =>
    (await p.quote({ cart: physical, weightGrams: w }))[0]?.amount;

  it("picks the first covering tier, boundaries inclusive", async () => {
    expect(await price(0)).toBe(400);
    expect(await price(500)).toBe(400);
    expect(await price(501)).toBe(900);
    expect(await price(10000)).toBe(2500);
    expect(await price(10001)).toBeUndefined();
  });

  it("price never decreases with weight (ascending tiers) and equals the first covering tier", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 12000 }),
        fc.integer({ min: 0, max: 12000 }),
        async (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const [pl, ph] = [await price(lo), await price(hi)];
          if (ph !== undefined) expect(pl).toBeLessThanOrEqual(ph);
          if (pl === undefined) expect(ph).toBeUndefined();
          expect(pl).toBe(tiers.find((t) => lo <= t.upToGrams)?.amount);
        },
      ),
    );
  });

  it("rejects unsorted, empty or duplicate tiers", () => {
    const bad = (t: unknown) =>
      weightBasedConfigSchema.safeParse({ ...weighted, tiers: t }).success;
    expect(bad([])).toBe(false);
    expect(bad([tiers[1], tiers[0]])).toBe(false);
    expect(bad([tiers[0], tiers[0]])).toBe(false);
    expect(bad(tiers)).toBe(true);
  });
});

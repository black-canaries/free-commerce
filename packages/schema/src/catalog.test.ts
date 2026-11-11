import { describe, expect, it } from "vitest";
import { Collection, newId, Product, Variant } from "./index.js";

const variant = {
  id: newId("var"),
  optionValues: {},
  deliveryType: "physical",
  priceMode: "fixed",
  prices: [{ currency: "USD", amount: 1000 }],
};
const issuePaths = (
  input: unknown,
  schema: typeof Variant | typeof Product,
) => {
  const r = schema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

describe("Variant", () => {
  it("defaults manageInventory by delivery type and keeps an explicit value", () => {
    const m = (extra: object) =>
      Variant.parse({ ...variant, ...extra }).manageInventory;
    expect(m({})).toBe(true);
    expect(m({ deliveryType: "digital" })).toBe(false);
    expect(m({ deliveryType: "none" })).toBe(false);
    expect(m({ deliveryType: "digital", manageInventory: true })).toBe(true);
    expect(Variant.parse(variant).taxCategory).toBe("standard");
  });

  it.each(["digital", "none"])(
    "rejects weight and dimensions on %s",
    (deliveryType) => {
      expect(
        issuePaths({ ...variant, deliveryType, weightGrams: 5 }, Variant),
      ).toEqual(["weightGrams"]);
      const dimensionsMm = { length: 1, width: 1, height: 1 };
      expect(
        issuePaths({ ...variant, deliveryType, dimensionsMm }, Variant),
      ).toEqual(["dimensionsMm"]);
    },
  );

  it("accepts weight and dimensions on physical", () => {
    const dimensionsMm = { length: 1, width: 1, height: 1 };
    expect(
      Variant.safeParse({ ...variant, weightGrams: 5, dimensionsMm }).success,
    ).toBe(true);
  });

  it("fixed needs an amount per currency; customer_defined needs ordered bounds, no fixed amount", () => {
    const bounds = { currency: "USD", min: 100, max: 500, suggested: 300 };
    const cd = { ...variant, priceMode: "customer_defined" };
    expect(Variant.safeParse({ ...cd, prices: [bounds] }).success).toBe(true);
    expect(issuePaths({ ...variant, prices: [bounds] }, Variant)).toEqual([
      "prices.0",
    ]);
    expect(issuePaths({ ...cd, prices: [] }, Variant)).toEqual([]);
    expect(
      issuePaths({ ...cd, prices: [{ currency: "USD", amount: 5 }] }, Variant),
    ).toEqual(["prices.0"]);
    expect(
      issuePaths({ ...cd, prices: [{ ...bounds, suggested: 900 }] }, Variant),
    ).toEqual(["prices.0.suggested"]);
  });

  it("rejects floats, negatives and duplicate currencies", () => {
    expect(
      Variant.safeParse({
        ...variant,
        prices: [{ currency: "USD", amount: 9.99 }],
      }).success,
    ).toBe(false);
    expect(
      Variant.safeParse({
        ...variant,
        prices: [{ currency: "USD", amount: -1 }],
      }).success,
    ).toBe(false);
    const dup = [
      { currency: "USD", amount: 1 },
      { currency: "USD", amount: 2 },
    ];
    expect(issuePaths({ ...variant, prices: dup }, Variant)).toEqual([
      "prices",
    ]);
  });
});

describe("Product and Collection", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const product = {
    id: newId("prod"),
    title: "Tee",
    handle: "tee",
    status: "draft",
    options: [{ name: "Size", values: ["S", "M"] }],
    variants: [
      { ...variant, id: newId("var"), optionValues: { Size: "S" } },
      { ...variant, id: newId("var"), optionValues: { Size: "M" } },
    ],
    createdAt: at,
    updatedAt: at,
  };

  it("accepts a valid product and rejects bad status or handle", () => {
    expect(Product.safeParse(product).success).toBe(true);
    expect(Product.safeParse({ ...product, status: "live" }).success).toBe(
      false,
    );
    expect(
      Product.safeParse({ ...product, handle: "Not A Slug" }).success,
    ).toBe(false);
  });

  it("rejects variants that miss, invent or repeat option combinations", () => {
    const [s, m] = product.variants;
    expect(
      issuePaths(
        { ...product, variants: [{ ...s, optionValues: {} }] },
        Product,
      ),
    ).toEqual(["variants.0.optionValues"]);
    expect(
      issuePaths(
        { ...product, variants: [{ ...s, optionValues: { Size: "XL" } }] },
        Product,
      ),
    ).toEqual(["variants.0.optionValues"]);
    expect(
      issuePaths(
        { ...product, variants: [s, { ...m, optionValues: { Size: "S" } }] },
        Product,
      ),
    ).toEqual(["variants.1.optionValues"]);
  });

  it("requires a variant, unique ids, and unique option names and values", () => {
    expect(Product.safeParse({ ...product, variants: [] }).success).toBe(false);
    expect(
      issuePaths(
        {
          ...product,
          variants: [
            product.variants[0],
            { ...product.variants[0], optionValues: { Size: "M" } },
          ],
        },
        Product,
      ),
    ).toEqual(["variants"]);
    const dup = [
      { name: "Size", values: ["S", "M"] },
      { name: "Size", values: ["L"] },
    ];
    expect(issuePaths({ ...product, options: dup }, Product)).toContain(
      "options",
    );
    expect(
      Product.safeParse({
        ...product,
        options: [{ name: "Size", values: ["S", "S"] }],
      }).success,
    ).toBe(false);
  });

  it("a simple product has one option-less default variant", () => {
    const simple = {
      ...product,
      options: [],
      variants: [{ ...variant, id: newId("var") }],
    };
    expect(Product.safeParse(simple).success).toBe(true);
    expect(
      Product.safeParse({
        ...simple,
        variants: [...simple.variants, { ...variant, id: newId("var") }],
      }).success,
    ).toBe(false);
  });

  it("collections list each product once", () => {
    const p = newId("prod");
    const c = {
      id: newId("col"),
      title: "Sale",
      handle: "sale",
      productIds: [p],
    };
    expect(Collection.safeParse(c).success).toBe(true);
    expect(Collection.safeParse({ ...c, productIds: [p, p] }).success).toBe(
      false,
    );
  });
});

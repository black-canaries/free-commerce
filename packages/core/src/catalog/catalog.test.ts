import { describe, expect, it } from "vitest";
import {
  archiveProduct,
  CatalogError,
  createProduct,
  type ProductInput,
  publishProduct,
  updateProduct,
} from "./catalog";

const simple = (
  over: Partial<ProductInput["variants"][0]> = {},
): ProductInput => ({
  title: "Mug",
  handle: "mug",
  variants: [
    {
      optionValues: {},
      deliveryType: "physical",
      priceMode: "fixed",
      prices: [{ currency: "USD", amount: 1200 }],
      ...over,
    },
  ],
});
const fails = (fn: () => unknown): CatalogError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CatalogError) return e;
  }
  throw new Error("expected CatalogError");
};

describe("catalog services", () => {
  it("creates a draft with generated ids and defaults", () => {
    const p = createProduct(simple());
    expect(p.status).toBe("draft");
    expect(p.id).toMatch(/^prod_/);
    expect(p.variants[0]).toMatchObject({
      manageInventory: true,
      taxCategory: "standard",
    });
    expect(p.variants[0]?.id).toMatch(/^var_/);
  });

  it("names the offending field on invalid variants", () => {
    const e = fails(() =>
      createProduct(simple({ deliveryType: "digital", weightGrams: 10 })),
    );
    expect(e.code).toBe("validation_failed");
    expect(e.issues).toEqual([
      {
        path: "variants.0.weightGrams",
        message: "only physical variants have a weight",
      },
    ]);
  });

  it("updates fields, revalidates, and bumps updatedAt", () => {
    const p = createProduct(simple(), new Date(0));
    const u = updateProduct(p, { title: "Big mug" }, new Date(1000));
    expect(u).toMatchObject({
      title: "Big mug",
      createdAt: p.createdAt,
      updatedAt: "1970-01-01T00:00:01.000Z",
    });
    expect(u.variants).toEqual(p.variants);
    const e = fails(() => updateProduct(p, { handle: "Bad Handle" }));
    expect(e.issues.map((i) => i.path)).toEqual(["handle"]);
  });

  it("recomputes the inventory default when variants are replaced", () => {
    const p = createProduct(simple());
    const u = updateProduct(p, simple({ deliveryType: "digital" }));
    expect(u.variants[0]?.manageInventory).toBe(false);
  });

  it("publishes draft once and requires a price on every variant", () => {
    const p = createProduct(simple());
    const live = publishProduct(p);
    expect(live.status).toBe("active");
    expect(fails(() => publishProduct(live)).code).toBe("conflict");
    const free = createProduct(simple({ prices: [] }));
    expect(fails(() => publishProduct(free)).issues[0]?.path).toBe(
      "variants.0.prices",
    );
  });

  it("archives draft or active, and archived products are terminal", () => {
    const p = createProduct(simple());
    const gone = archiveProduct(publishProduct(p));
    expect(gone.status).toBe("archived");
    expect(archiveProduct(p).status).toBe("archived");
    expect(fails(() => archiveProduct(gone)).code).toBe("conflict");
    expect(fails(() => publishProduct(gone)).code).toBe("conflict");
    expect(fails(() => updateProduct(gone, { title: "x" })).code).toBe(
      "conflict",
    );
  });
});

import { type Product, SearchQuery } from "@free-commerce/schema";
import { describe, expect, it } from "vitest";
import { toSearchDoc } from "./search";
import { searchConformance } from "./search.conformance";
import { createFakeSearch } from "./search.fake";

searchConformance("fake", createFakeSearch);

const product = {
  id: "prod_1",
  title: "Tee",
  handle: "tee",
  status: "active",
  options: [{ name: "Size", values: ["S", "M"] }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  variants: [
    ["S", 2000],
    ["M", 3000],
  ].map(([size, amount]) => ({
    id: `var_${size}`,
    optionValues: { Size: size },
    deliveryType: "physical",
    priceMode: "fixed",
    prices: [{ currency: "USD", amount }],
  })),
} as unknown as Product;

describe("toSearchDoc", () => {
  it("folds variants into options, delivery types and per-currency price range", () => {
    expect(toSearchDoc(product, ["col_a"], true)).toMatchObject({
      options: { Size: ["S", "M"] },
      deliveryTypes: ["physical"],
      prices: { USD: { min: 2000, max: 3000 } },
      collectionIds: ["col_a"],
    });
  });
  it("is null unless the product is active", () => {
    expect(toSearchDoc({ ...product, status: "draft" }, [], true)).toBeNull();
  });
});

describe("SearchQuery", () => {
  it("needs a currency for price filters and price sorts", () => {
    expect(SearchQuery.safeParse({ price: { max: 5 } }).success).toBe(false);
    expect(SearchQuery.safeParse({ sort: "price_asc" }).success).toBe(false);
    expect(
      SearchQuery.safeParse({ sort: "price_asc", currency: "USD" }).success,
    ).toBe(true);
  });
});

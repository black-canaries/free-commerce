import type { Cart, Product } from "@free-commerce/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createProduct, publishProduct } from "../catalog/catalog";
import type { CartRepository } from "../repositories";
import {
  addLine,
  CartError,
  cartTotals,
  createCart,
  getCart,
  newCart,
  removeLine,
  requiresShipping,
  updateLine,
} from "./cart";

const product = (): Product =>
  publishProduct(
    createProduct({
      title: "Shop",
      handle: "shop",
      options: [{ name: "kind", values: ["mug", "ebook", "tip", "wine"] }],
      variants: [
        {
          id: "var_00000000000000000000000001",
          optionValues: { kind: "mug" },
          deliveryType: "physical",
          priceMode: "fixed",
          prices: [{ currency: "USD", amount: 1200 }],
        },
        {
          id: "var_00000000000000000000000002",
          optionValues: { kind: "ebook" },
          deliveryType: "digital",
          priceMode: "fixed",
          prices: [{ currency: "USD", amount: 500 }],
        },
        {
          id: "var_00000000000000000000000003",
          optionValues: { kind: "tip" },
          deliveryType: "none",
          priceMode: "customer_defined",
          prices: [{ currency: "USD", min: 100, max: 10000, suggested: 500 }],
        },
        {
          id: "var_00000000000000000000000004",
          optionValues: { kind: "wine" },
          deliveryType: "physical",
          priceMode: "fixed",
          quantityUnit: "bottle",
          prices: [{ currency: "EUR", amount: 900 }],
        },
      ],
    }),
  );
const MUG = "var_00000000000000000000000001";
const EBOOK = "var_00000000000000000000000002";
const TIP = "var_00000000000000000000000003";
const WINE = "var_00000000000000000000000004";
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CartError) return e.code;
  }
  return undefined;
};

describe("cart lines", () => {
  const p = product();
  const empty = newCart("USD");

  it("adds fixed and customer-defined lines, merging identical ones", () => {
    let c = addLine(empty, p, MUG, 1);
    c = addLine(c, p, MUG, 2);
    c = addLine(c, p, TIP, 1); // suggested
    c = addLine(c, p, TIP, 1, 2500);
    expect(c.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([
      [3, 1200],
      [1, 500],
      [1, 2500],
    ]);
  });

  it("rejects bad amounts, missing prices, inactive products and unknown ids", () => {
    expect(code(() => addLine(empty, p, TIP, 1, 99))).toBe("invalid");
    expect(code(() => addLine(empty, p, TIP, 1, 10.5))).toBe("invalid");
    expect(code(() => addLine(empty, p, MUG, 1, 5))).toBe("invalid");
    expect(code(() => addLine(empty, p, WINE, 1))).toBe("invalid"); // no USD price
    expect(code(() => addLine(empty, p, "var_x", 1))).toBe("not_found");
    expect(code(() => addLine(empty, { ...p, status: "draft" }, MUG, 1))).toBe(
      "invalid",
    );
    expect(() => addLine(empty, p, MUG, 0)).toThrow();
  });

  it("keeps the quantity unit, updates and removes", () => {
    const eur = addLine(newCart("EUR"), p, WINE, 6);
    expect(eur.lines[0]?.quantityUnit).toBe("bottle");
    const c = addLine(empty, p, MUG, 1);
    const id = c.lines[0]?.id ?? "";
    expect(updateLine(c, id, 4).lines[0]?.quantity).toBe(4);
    expect(() => updateLine(c, id, 0)).toThrow();
    expect(removeLine(c, id).lines).toEqual([]);
    expect(code(() => removeLine(c, "line_x"))).toBe("not_found");
  });
});

describe("shipping and totals", () => {
  const p = product();
  it("requires shipping only with a physical line", () => {
    const digital = addLine(addLine(newCart("USD"), p, EBOOK, 1), p, TIP, 1);
    expect(requiresShipping(digital)).toBe(false);
    expect(cartTotals(digital, { shipping: 700 }).shipping.amount).toBe(0);
    const phys = addLine(digital, p, MUG, 1);
    expect(requiresShipping(phys)).toBe(true);
    expect(cartTotals(phys, { shipping: 700 }).shipping.amount).toBe(700);
  });

  const line = fc.record({
    unitPrice: fc.integer({ min: 0, max: 1_000_000 }),
    quantity: fc.integer({ min: 1, max: 1000 }),
    deliveryType: fc.constantFrom("physical", "digital", "none"),
  });
  const adj = fc.integer({ min: 0, max: 10_000_000 });
  it("total = subtotal - discount + shipping + tax; discount never exceeds subtotal", () => {
    fc.assert(
      fc.property(
        fc.array(line),
        adj,
        adj,
        adj,
        (lines, discount, shipping, tax) => {
          const cart = {
            ...newCart("USD"),
            lines: lines.map((l, i) => ({
              ...l,
              id: `line_${i}`,
              variantId: "var_x",
              title: "t",
              taxCategory: "standard",
            })),
          } as Cart;
          const t = cartTotals(cart, { discount, shipping, tax });
          const sub = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
          expect(t.subtotal.amount).toBe(sub);
          expect(t.discount.amount).toBe(Math.min(discount, sub));
          expect(t.total.amount).toBe(
            sub - t.discount.amount + t.shipping.amount + tax,
          );
          expect(t.total.amount).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe("persistence", () => {
  it("creates and gets a cart; unknown id is not_found", async () => {
    const store = new Map<string, { id: string }>();
    const carts = {
      get: async (id: string) => store.get(id) ?? null,
      save: async (e: { id: string }) => void store.set(e.id, e),
    } as CartRepository;
    const c = await createCart(carts, "USD");
    expect(await getCart(carts, c.id)).toEqual(c);
    await expect(getCart(carts, "cart_x")).rejects.toThrow(/not_found/);
  });
});

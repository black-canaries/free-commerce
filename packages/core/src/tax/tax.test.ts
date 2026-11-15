import type { Cart, TaxRegion } from "@free-commerce/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cartTotals, newCart } from "../cart/cart";
import { calculateTax, findTaxRegion } from "./tax";

const region = (
  inclusive: boolean,
  rates = { standard: 2000, digital: 500 },
): TaxRegion => ({
  country: "DE",
  inclusive,
  rates,
});

const cartOf = (
  specs: {
    price: number;
    qty: number;
    cat: string;
    type?: "physical" | "digital";
  }[],
): Cart => ({
  ...newCart("EUR"),
  lines: specs.map((s, i) => ({
    id: `line_${String(i).padStart(26, "0")}`,
    variantId: `var_${String(i).padStart(26, "0")}`,
    title: "x",
    deliveryType: s.type ?? "physical",
    taxCategory: s.cat,
    quantity: s.qty,
    unitPrice: s.price,
  })),
});

const spec = fc.record({
  price: fc.integer({ min: 0, max: 1_000_000 }),
  qty: fc.integer({ min: 1, max: 50 }),
  cat: fc.constantFrom("standard", "digital", "exempt", "unknown"),
});
const rates = fc.record({
  standard: fc.integer({ min: 0, max: 3000 }),
  digital: fc.integer({ min: 0, max: 3000 }),
});

describe("calculateTax", () => {
  it("adds exclusive tax on top, rounding half-up per line", () => {
    const cart = cartOf([{ price: 1005, qty: 1, cat: "standard" }]); // 201.0
    expect(calculateTax(cart, region(false)).total).toBe(201);
    const half = cartOf([{ price: 1025, qty: 1, cat: "digital" }]); // 51.25
    expect(calculateTax(half, region(false)).total).toBe(51);
    const up = cartOf([{ price: 1030, qty: 1, cat: "digital" }]); // 51.5
    expect(calculateTax(up, region(false)).total).toBe(52);
  });

  it("extracts inclusive tax and leaves the total unchanged", () => {
    const cart = cartOf([{ price: 1200, qty: 1, cat: "standard" }]);
    const t = calculateTax(cart, region(true));
    expect(t.total).toBe(200);
    expect(
      cartTotals(cart, { tax: t.total, taxIncluded: t.inclusive }).total.amount,
    ).toBe(1200);
    expect(cartTotals(cart, { tax: 5 }).total.amount).toBe(1205);
  });

  it("exempt, unknown categories and missing regions are untaxed", () => {
    const cart = cartOf([
      { price: 1000, qty: 1, cat: "exempt" },
      { price: 1000, qty: 1, cat: "mystery" },
    ]);
    expect(calculateTax(cart, region(false)).total).toBe(0);
    expect(
      calculateTax(
        cartOf([{ price: 1000, qty: 1, cat: "standard" }]),
        undefined,
      ).total,
    ).toBe(0);
  });

  it("taxes shipping at the standard rate only for carts that ship", () => {
    const physical = cartOf([{ price: 1000, qty: 1, cat: "exempt" }]);
    expect(calculateTax(physical, region(false), 500).shipping).toBe(100);
    const digital = cartOf([
      { price: 1000, qty: 1, cat: "digital", type: "digital" },
    ]);
    expect(calculateTax(digital, region(false), 500).shipping).toBe(0);
  });

  it("picks the most specific region", () => {
    const de: TaxRegion = region(false);
    const by: TaxRegion = { ...de, state: "BY" };
    expect(findTaxRegion([de, by], "DE", "BY")).toBe(by);
    expect(findTaxRegion([de, by], "DE", "BE")).toBe(de);
    expect(findTaxRegion([de], "FR")).toBeUndefined();
  });

  it("property: total equals the sum of line and shipping taxes", () => {
    fc.assert(
      fc.property(
        fc.array(spec, { maxLength: 8 }),
        rates,
        fc.boolean(),
        fc.nat(100_000),
        (specs, r, inc, ship) => {
          const t = calculateTax(cartOf(specs), region(inc, r), ship);
          expect(t.total).toBe(t.lines.reduce((s, l) => s + l.tax, t.shipping));
        },
      ),
    );
  });

  it("property: inclusive tax never exceeds the price and the total reconciles", () => {
    fc.assert(
      fc.property(
        fc.array(spec, { minLength: 1, maxLength: 8 }),
        rates,
        (specs, r) => {
          const cart = cartOf(specs);
          const t = calculateTax(cart, region(true, r));
          t.lines.forEach((l, i) => {
            const gross = (specs[i]?.price ?? 0) * (specs[i]?.qty ?? 0);
            expect(l.tax).toBeGreaterThanOrEqual(0);
            expect(l.tax).toBeLessThanOrEqual(gross);
          });
          const subtotal = cartTotals(cart).subtotal.amount;
          expect(
            cartTotals(cart, { tax: t.total, taxIncluded: true }).total.amount,
          ).toBe(subtotal);
        },
      ),
    );
  });

  it("property: inclusive and exclusive round-trip within one minor unit per line", () => {
    fc.assert(
      fc.property(spec, rates, (s, r) => {
        const inc = calculateTax(cartOf([s]), region(true, r)).total;
        const net = s.price * s.qty - inc;
        const exc = calculateTax(
          cartOf([{ price: net, qty: 1, cat: s.cat }]),
          region(false, r),
        ).total;
        expect(Math.abs(exc - inc)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("property: zero-rate and exempt lines never carry tax", () => {
    fc.assert(
      fc.property(spec, fc.boolean(), (s, inc) => {
        const t = calculateTax(
          cartOf([{ ...s, cat: "exempt" }]),
          region(inc),
          0,
        );
        expect(t.total).toBe(0);
      }),
    );
  });
});

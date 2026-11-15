import { allocate, type Cart, type TaxRegion } from "@free-commerce/schema";
import { requiresShipping } from "../cart/cart";

/** @experimental Line and shipping taxes in minor units; `total` is their exact sum. */
export type TaxResult = {
  lines: { lineId: string; tax: number }[];
  shipping: number;
  total: number;
  /** True when prices already contain the tax, so `total` must not be added to the order total. */
  inclusive: boolean;
};

/** @experimental Most specific match wins: country + state, then country alone. */
export function findTaxRegion(
  regions: readonly TaxRegion[],
  country: string,
  state?: string,
): TaxRegion | undefined {
  return (
    regions.find((r) => r.country === country && state && r.state === state) ??
    regions.find((r) => r.country === country && !r.state)
  );
}

/** Half-up on a non-negative integer ratio; exact in integers, never floats. */
const roundDiv = (n: number, d: number): number =>
  Math.floor((2 * n + d) / (2 * d));

const taxOn = (gross: number, bp: number, inclusive: boolean): number =>
  inclusive ? roundDiv(gross * bp, 10_000 + bp) : roundDiv(gross * bp, 10_000);

/**
 * @experimental Tax per line (on `unitPrice * quantity`, rounded half-up once per line) plus tax on
 * `shipping` at the `standard` rate when the cart ships. The total is the sum of the rounded parts, so
 * it always reconciles. A cart `discount` is allocated across lines by line total (largest remainder, so the parts sum exactly) and tax is computed on the discounted amounts; pass `shipping` already reduced by free shipping. No region means no tax. Inclusive: tax is extracted from the price
 * (`gross * r / (1 + r)`); exclusive: added on top (`net * r`).
 */
export function calculateTax(
  cart: Cart,
  region: TaxRegion | undefined,
  shipping = 0,
  discount = 0,
): TaxResult {
  const inclusive = region?.inclusive ?? false;
  const rate = (category: string) =>
    category === "exempt" ? 0 : (region?.rates[category] ?? 0);
  const totals = cart.lines.map((l) => l.unitPrice * l.quantity);
  const subtotal = totals.reduce((s, n) => s + n, 0);
  const off =
    subtotal > 0
      ? allocate(
          { amount: Math.min(discount, subtotal), currency: cart.currency },
          totals,
        ).map((m) => m.amount)
      : totals.map(() => 0);
  const lines = cart.lines.map((l, i) => ({
    lineId: l.id,
    tax: taxOn(
      (totals[i] ?? 0) - (off[i] ?? 0),
      rate(l.taxCategory),
      inclusive,
    ),
  }));
  const ship = requiresShipping(cart)
    ? taxOn(shipping, rate("standard"), inclusive)
    : 0;
  return {
    lines,
    shipping: ship,
    total: lines.reduce((s, l) => s + l.tax, ship),
    inclusive,
  };
}

import {
  type Cart,
  type CartLine,
  Cart as CartSchema,
  type Money,
  newId,
  type Product,
  toTimestamp,
} from "@free-commerce/schema";
import type { CartRepository } from "../repositories";

/** @experimental `not_found`: unknown cart/line/variant; `invalid`: a rule was broken (inactive product, bad amount, currency). */
export class CartError extends Error {
  constructor(
    readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CartError";
  }
}

const invalid = (m: string) => new CartError("invalid", m);
const touch = (cart: Cart, lines: CartLine[], now: Date): Cart => ({
  ...cart,
  lines,
  updatedAt: toTimestamp(now),
});

/** @experimental */
export function newCart(currency: string, now = new Date()): Cart {
  const at = toTimestamp(now);
  return CartSchema.parse({
    id: newId("cart", now.getTime()),
    currency,
    lines: [],
    createdAt: at,
    updatedAt: at,
  });
}

/** @experimental Creates and persists an empty cart. */
export async function createCart(
  repo: CartRepository,
  currency: string,
  now = new Date(),
): Promise<Cart> {
  const cart = newCart(currency, now);
  await repo.save(cart);
  return cart;
}

/** @experimental Throws `CartError("not_found")`. */
export async function getCart(repo: CartRepository, id: string): Promise<Cart> {
  const found = await repo.get(id);
  if (!found) throw new CartError("not_found", `cart ${id}`);
  return CartSchema.parse(found);
}

const priceOf = (
  variant: Product["variants"][number],
  currency: string,
  amount?: number,
): number => {
  const price = variant.prices.find((p) => p.currency === currency);
  if (!price) throw invalid(`no ${currency} price`);
  if ("amount" in price) {
    if (amount !== undefined && amount !== price.amount)
      throw invalid("amount only applies to customer_defined variants");
    return price.amount;
  }
  const chosen = amount ?? price.suggested;
  if (!Number.isInteger(chosen) || chosen < price.min || chosen > price.max)
    throw invalid(`amount must be an integer in ${price.min}..${price.max}`);
  return chosen;
};

/**
 * @experimental Adds a variant of an active product, priced in the cart currency. `amount` is required
 * only for `customer_defined` variants (defaults to the suggested amount) and must lie within min/max.
 * An identical variant and price merges into the existing line.
 */
export function addLine(
  cart: Cart,
  product: Product,
  variantId: string,
  quantity: number,
  amount?: number,
  now = new Date(),
): Cart {
  if (product.status !== "active") throw invalid("product is not active");
  const variant = product.variants.find((v) => v.id === variantId);
  if (!variant) throw new CartError("not_found", `variant ${variantId}`);
  const unitPrice = priceOf(variant, cart.currency, amount);
  const same = cart.lines.find(
    (l) => l.variantId === variantId && l.unitPrice === unitPrice,
  );
  const lines = same
    ? cart.lines.map((l) =>
        l === same ? { ...l, quantity: l.quantity + quantity } : l,
      )
    : [
        ...cart.lines,
        {
          id: newId("line", now.getTime()),
          variantId,
          title: product.title,
          deliveryType: variant.deliveryType,
          taxCategory: variant.taxCategory,
          quantity,
          ...(variant.quantityUnit && { quantityUnit: variant.quantityUnit }),
          unitPrice,
        },
      ];
  return CartSchema.parse(touch(cart, lines, now));
}

const line = (cart: Cart, lineId: string): CartLine => {
  const l = cart.lines.find((x) => x.id === lineId);
  if (!l) throw new CartError("not_found", `line ${lineId}`);
  return l;
};

/** @experimental Sets the quantity (positive integer); use `removeLine` to drop a line. */
export function updateLine(
  cart: Cart,
  lineId: string,
  quantity: number,
  now = new Date(),
): Cart {
  line(cart, lineId);
  return CartSchema.parse(
    touch(
      cart,
      cart.lines.map((l) => (l.id === lineId ? { ...l, quantity } : l)),
      now,
    ),
  );
}

/** @experimental */
export function removeLine(cart: Cart, lineId: string, now = new Date()): Cart {
  line(cart, lineId);
  return touch(
    cart,
    cart.lines.filter((l) => l.id !== lineId),
    now,
  );
}

/** @experimental Derived from line delivery types; carts with no physical line skip shipping. */
export const requiresShipping = (cart: Cart): boolean =>
  cart.lines.some((l) => l.deliveryType === "physical");

/** @experimental */
export type CartTotals = {
  subtotal: Money;
  discount: Money;
  shipping: Money;
  tax: Money;
  total: Money;
};

/**
 * @experimental `total = subtotal - discount + shipping + tax`. Discount, shipping and tax come from
 * their own engines (pricing, shipping, tax) in minor units; discount is capped at the subtotal and
 * shipping is zero when `requiresShipping` is false. With `taxIncluded` the tax is reported but already
 * part of the prices, so it is not added to the total.
 */
export function cartTotals(
  cart: Cart,
  adjustments: {
    discount?: number;
    shipping?: number;
    tax?: number;
    taxIncluded?: boolean;
  } = {},
): CartTotals {
  const { currency } = cart;
  for (const n of [adjustments.discount, adjustments.shipping, adjustments.tax])
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
      throw invalid("adjustments must be non-negative integers");
  const subtotal = cart.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const discount = Math.min(adjustments.discount ?? 0, subtotal);
  const shipping = requiresShipping(cart) ? (adjustments.shipping ?? 0) : 0;
  const tax = adjustments.tax ?? 0;
  const m = (amount: number): Money => ({ amount, currency });
  return {
    subtotal: m(subtotal),
    discount: m(discount),
    shipping: m(shipping),
    tax: m(tax),
    total: m(
      subtotal - discount + shipping + (adjustments.taxIncluded ? 0 : tax),
    ),
  };
}

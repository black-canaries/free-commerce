import { type Cart, DiscountCode, multiply } from "@free-commerce/schema";
import { requiresShipping } from "../cart/cart";
import type { DiscountRepository } from "../repositories";

/** @experimental Why a code cannot be used; `not_found` for an unknown code. */
export type DiscountReason =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "currency"
  | "min_subtotal"
  | "no_shipping"
  | "usage_limit"
  | "customer_limit";

/** @experimental */
export class DiscountError extends Error {
  constructor(readonly reason: DiscountReason) {
    super(`discount: ${reason}`);
    this.name = "DiscountError";
  }
}

/**
 * @experimental What a valid code does: `amount` off the subtotal, and/or shipping zeroed. Feed `amount` to
 * `cartTotals` and `calculateTax` as `discount`, and pass `shipping` 0 to both when `freeShipping`.
 */
export type DiscountEffect = {
  code: DiscountCode;
  /** Minor units off the goods subtotal; never above it. */
  amount: number;
  freeShipping: boolean;
};

/** @experimental Customers type codes in any case with stray spaces. */
export const normalizeCode = (raw: string): string => raw.trim().toUpperCase();

const subtotalOf = (cart: Cart) =>
  cart.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

const staticReason = (
  code: DiscountCode,
  cart: Cart,
  subtotal: number,
  at: string,
): DiscountReason | undefined => {
  if (!code.active) return "inactive";
  if (code.startsAt && code.startsAt > at) return "not_started";
  if (code.endsAt && code.endsAt <= at) return "expired";
  if (code.minSubtotal && subtotal < code.minSubtotal) return "min_subtotal";
  if (code.type === "fixed" && code.currency !== cart.currency)
    return "currency";
  if (code.type === "free_shipping" && !requiresShipping(cart))
    return "no_shipping";
};

/** @experimental Shared by adapters inside `redeem` so limit semantics cannot drift. */
export const usageRefusal = (
  code: DiscountCode,
  usage: { total: number; customer: number },
  customerKey?: string,
): "usage_limit" | "customer_limit" | undefined => {
  if (code.usageLimit !== undefined && usage.total >= code.usageLimit)
    return "usage_limit";
  if (
    code.perCustomerLimit !== undefined &&
    customerKey !== undefined &&
    usage.customer >= code.perCustomerLimit
  )
    return "customer_limit";
};

/**
 * @experimental Validates `rawCode` against the cart and returns its effect, or throws `DiscountError`.
 * Usage limits are checked against current usage for a friendly early error; `redeemDiscount` is the
 * authoritative, race-safe check. `customerKey` (customer id, or lower-cased guest email) enables the
 * per-customer limit. Percentages round half away from zero on the subtotal.
 */
export async function applyDiscount(
  repo: DiscountRepository,
  cart: Cart,
  rawCode: string,
  now: Date,
  customerKey?: string,
): Promise<DiscountEffect> {
  const found = await repo.getByCode(normalizeCode(rawCode));
  if (!found) throw new DiscountError("not_found");
  const code = DiscountCode.parse(found);
  const at = now.toISOString();
  const subtotal = subtotalOf(cart);
  const bad = staticReason(code, cart, subtotal, at);
  if (bad) throw new DiscountError(bad);
  const usage = await repo.usage(code.id, customerKey);
  const full = usageRefusal(code, usage, customerKey);
  if (full) throw new DiscountError(full);
  const raw =
    code.type === "percentage"
      ? multiply(
          { amount: subtotal, currency: cart.currency },
          code.basisPoints,
          10_000,
        ).amount
      : code.type === "fixed"
        ? code.amount
        : 0;
  return {
    code,
    amount: Math.min(raw, subtotal),
    freeShipping: code.type === "free_shipping",
  };
}

/**
 * @experimental Records a redemption (call when the order is created). Idempotent by `redemptionId`
 * (use the order id): a retry succeeds without counting twice. Throws `DiscountError` when a limit was
 * reached by a concurrent order. Pair with `releaseDiscount` to compensate a failed checkout.
 */
export async function redeemDiscount(
  repo: DiscountRepository,
  code: DiscountCode,
  redemptionId: string,
  customerKey?: string,
): Promise<void> {
  const r = await repo.redeem(code.id, redemptionId, customerKey);
  if (!r.ok) throw new DiscountError(r.reason);
}

/** @experimental Undoes a redemption; unknown or already released ids are a no-op. */
export const releaseDiscount = (
  repo: DiscountRepository,
  redemptionId: string,
) => repo.release(redemptionId);

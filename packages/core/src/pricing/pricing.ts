import type { Money, Price, Variant } from "@free-commerce/schema";

/** @experimental `no_price`: nothing for the currency; `amount_required`/`out_of_bounds`: customer-defined amount problems. */
export class PricingError extends Error {
  constructor(
    readonly code: "no_price" | "amount_required" | "out_of_bounds",
    message: string,
  ) {
    super(message);
    this.name = "PricingError";
  }
}

export type PriceOptions = {
  /** Used when the variant has no price in the requested currency (e.g. the store's default currency). */
  fallbackCurrency?: string;
  /** Customer-defined only: the amount the customer chose, in minor units. */
  chosenAmount?: number;
  /** Customer-defined only: smallest amount the payment provider accepts in the charged currency. */
  providerMinimum?: number;
};

/**
 * @experimental Unit price of a variant for a currency (the caller maps region to currency). Fixed: the
 * configured amount. Customer-defined: `chosenAmount` after checking `max(min, providerMinimum) <= amount <= max`.
 * The result carries the currency actually charged, which is the fallback when the requested one is missing.
 */
export function resolvePrice(
  variant: Pick<Variant, "prices">,
  currency: string,
  opts: PriceOptions = {},
): Money {
  const find = (c: string | undefined): Price | undefined =>
    variant.prices.find((p) => p.currency === c);
  const price = find(currency) ?? find(opts.fallbackCurrency);
  if (!price) throw new PricingError("no_price", `no price in ${currency}`);
  if ("amount" in price)
    return { amount: price.amount, currency: price.currency };
  const { chosenAmount: amount, providerMinimum = 0 } = opts;
  if (amount === undefined)
    throw new PricingError(
      "amount_required",
      "customer-defined price needs an amount",
    );
  const floor = Math.max(price.min, providerMinimum);
  if (!Number.isSafeInteger(amount) || amount < floor || amount > price.max)
    throw new PricingError(
      "out_of_bounds",
      `amount must be an integer between ${floor} and ${price.max} ${price.currency}`,
    );
  return { amount, currency: price.currency };
}

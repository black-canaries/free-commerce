import type { Cart } from "@free-commerce/schema";
import { z } from "zod";
import { requiresShipping } from "../cart/cart";

/** @experimental A selectable shipping choice; `amount` is integer minor units in the cart currency. */
export type ShippingOption = { id: string; label: string; amount: number };

/** @experimental `weightGrams` is the total physical weight, resolved by the caller from the catalog. */
export type ShippingQuoteInput = { cart: Cart; weightGrams: number };

/**
 * @experimental Rates shipping options for a cart. Returns `[]` when none apply (e.g. over the
 * weight limit or another currency); failures are `ProviderError`. Callers use `shippingOptions`,
 * which skips carts that need no shipping.
 */
export interface ShippingProvider {
  quote(input: ShippingQuoteInput): Promise<ShippingOption[]>;
}

/** @experimental Options for a cart, or `[]` without calling the provider if nothing physical is in it. */
export const shippingOptions = (
  provider: ShippingProvider,
  input: ShippingQuoteInput,
): Promise<ShippingOption[]> =>
  requiresShipping(input.cart) ? provider.quote(input) : Promise.resolve([]);

const base = {
  id: z.string().min(1),
  label: z.string().min(1),
  currency: z.string().length(3),
};
const amount = z.number().int().nonnegative();

/** @experimental One fixed-price option. */
export const flatRateConfigSchema = z.object({ ...base, amount });
export type FlatRateConfig = z.infer<typeof flatRateConfigSchema>;

/** @experimental One option priced by weight: the first tier whose `upToGrams` covers the cart. */
export const weightBasedConfigSchema = z.object({
  ...base,
  tiers: z
    .array(z.object({ upToGrams: z.number().int().positive(), amount }))
    .min(1)
    .refine(
      (t) =>
        t.every((x, i) => i === 0 || x.upToGrams > (t[i - 1]?.upToGrams ?? 0)),
      "tiers must be sorted by strictly increasing upToGrams",
    ),
});
export type WeightBasedConfig = z.infer<typeof weightBasedConfigSchema>;

/** @experimental */
export function createFlatRateShipping(
  config: FlatRateConfig,
): ShippingProvider {
  const {
    id,
    label,
    currency,
    amount: price,
  } = flatRateConfigSchema.parse(config);
  return {
    async quote({ cart }) {
      return cart.currency === currency ? [{ id, label, amount: price }] : [];
    },
  };
}

/** @experimental Heavier than the last tier means no option. */
export function createWeightBasedShipping(
  config: WeightBasedConfig,
): ShippingProvider {
  const { id, label, currency, tiers } = weightBasedConfigSchema.parse(config);
  return {
    async quote({ cart, weightGrams }) {
      const tier = tiers.find((t) => weightGrams <= t.upToGrams);
      return tier && cart.currency === currency
        ? [{ id, label, amount: tier.amount }]
        : [];
    },
  };
}

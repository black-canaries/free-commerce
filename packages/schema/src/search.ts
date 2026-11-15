import { z } from "zod";
import { CollectionId, DeliveryType } from "./catalog.js";
import { CurrencyCode } from "./money.js";
import { PageQuery } from "./page.js";

const Amount = z.number().int().nonnegative();

/**
 * Catalog search request. `options` maps an option name to accepted values (any-of per name, all names
 * must match). `price` bounds are inclusive minor units and need `currency`, as do the price sorts.
 * `relevance` without `q` falls back to `newest`.
 */
export const SearchQuery = z
  .strictObject({
    q: z.string().trim().max(200).optional(),
    collectionId: CollectionId.optional(),
    options: z.record(z.string(), z.array(z.string()).min(1)).optional(),
    currency: CurrencyCode.optional(),
    price: z
      .strictObject({ min: Amount.optional(), max: Amount.optional() })
      .optional(),
    available: z.boolean().optional(),
    deliveryType: DeliveryType.optional(),
    sort: z
      .enum(["relevance", "newest", "price_asc", "price_desc"])
      .default("relevance"),
  })
  .extend(PageQuery.shape)
  .refine(
    (s) =>
      s.currency !== undefined || (!s.price && !s.sort.startsWith("price")),
    {
      path: ["currency"],
      message: "required for price filters and price sorts",
    },
  );
export type SearchQuery = z.infer<typeof SearchQuery>;

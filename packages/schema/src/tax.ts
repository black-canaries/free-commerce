import { z } from "zod";

/**
 * Merchant-entered tax for one country (or one state of it). `rates` maps a variant `taxCategory`
 * to a rate in basis points (725 = 7.25%); `exempt` is always 0 and a category with no entry is 0.
 * `inclusive`: catalogue prices already contain the tax.
 */
export const TaxRegion = z.object({
  country: z.string().regex(/^[A-Z]{2}$/),
  state: z.string().trim().min(1).optional(),
  inclusive: z.boolean(),
  rates: z.record(z.string().min(1), z.number().int().min(0).max(10_000)),
});
export type TaxRegion = z.infer<typeof TaxRegion>;

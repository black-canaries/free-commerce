import { z } from "zod";
import { idSchema } from "./id.js";
import { CurrencyCode } from "./money.js";
import { Timestamp } from "./time.js";

export const ProductId = idSchema("prod");
export const VariantId = idSchema("var");
export const CollectionId = idSchema("col");

export const ProductStatus = z.enum(["draft", "active", "archived"]);
export type ProductStatus = z.infer<typeof ProductStatus>;

export const DeliveryType = z.enum(["physical", "digital", "none"]);
export const PriceMode = z.enum(["fixed", "customer_defined"]);

const Amount = z.number().int().nonnegative();
const FixedPrice = z.strictObject({ currency: CurrencyCode, amount: Amount });
const BoundedPrice = z.strictObject({
  currency: CurrencyCode,
  min: Amount,
  max: Amount,
  suggested: Amount,
});

/** Per currency: a fixed amount, or min/max/suggested bounds for `customer_defined`. Minor units. */
export const Price = z.union([FixedPrice, BoundedPrice]);
export type Price = z.infer<typeof Price>;

const names = (xs: string[]) => new Set(xs).size === xs.length;

/**
 * Sellable unit. Rules: weight and dimensions only for `physical`; prices match `priceMode`;
 * `manageInventory` defaults to true for physical and false otherwise.
 */
export const Variant = z
  .strictObject({
    id: VariantId,
    sku: z.string().min(1).optional(),
    /** Option name to chosen value; empty for a simple product's default variant. */
    optionValues: z.record(z.string(), z.string()),
    deliveryType: DeliveryType,
    priceMode: PriceMode,
    taxCategory: z.string().min(1).default("standard"),
    /** Display label only ("kg", "hour"); never affects maths. */
    quantityUnit: z.string().min(1).optional(),
    manageInventory: z.boolean().optional(),
    allowBackorder: z.boolean().default(false),
    weightGrams: z.number().int().positive().optional(),
    dimensionsMm: z
      .strictObject({
        length: z.number().int().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    prices: z.array(Price),
  })
  .superRefine((v, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (v.deliveryType !== "physical") {
      if (v.weightGrams !== undefined)
        bad(["weightGrams"], "only physical variants have a weight");
      if (v.dimensionsMm !== undefined)
        bad(["dimensionsMm"], "only physical variants have dimensions");
    }
    if (!names(v.prices.map((p) => p.currency)))
      bad(["prices"], "one price per currency");
    v.prices.forEach((p, i) => {
      if (v.priceMode === "fixed" && !("amount" in p))
        bad(["prices", i], "fixed variants need an amount per currency");
      if (v.priceMode === "customer_defined") {
        if (!("min" in p))
          bad(
            ["prices", i],
            "customer_defined variants need min, max and suggested",
          );
        else if (!(p.min <= p.suggested && p.suggested <= p.max))
          bad(
            ["prices", i, "suggested"],
            "must satisfy min <= suggested <= max",
          );
      }
    });
  })
  .transform((v) => ({
    ...v,
    manageInventory: v.manageInventory ?? v.deliveryType === "physical",
  }));
export type Variant = z.infer<typeof Variant>;

export const ProductOption = z.strictObject({
  name: z.string().min(1),
  values: z
    .array(z.string().min(1))
    .min(1)
    .refine(names, "option values must be unique"),
});

/**
 * Aggregate root: options and variants live inside the product. Every variant picks exactly one value
 * of every option and no two share a combination; a product without options has one default variant.
 */
export const Product = z
  .strictObject({
    id: ProductId,
    title: z.string().trim().min(1),
    handle: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().optional(),
    status: ProductStatus,
    options: z.array(ProductOption),
    variants: z.array(Variant).min(1),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .superRefine((p, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const optionNames = p.options.map((o) => o.name);
    if (!names(optionNames)) bad(["options"], "option names must be unique");
    if (!names(p.variants.map((v) => v.id)))
      bad(["variants"], "variant ids must be unique");
    const combos = new Set<string>();
    p.variants.forEach((v, i) => {
      const chosen = Object.keys(v.optionValues);
      if (
        chosen.length !== optionNames.length ||
        !p.options.every((o) => o.values.includes(v.optionValues[o.name] ?? ""))
      )
        bad(
          ["variants", i, "optionValues"],
          "must pick one valid value of every option",
        );
      const combo = JSON.stringify(optionNames.map((n) => v.optionValues[n]));
      if (combos.has(combo))
        bad(["variants", i, "optionValues"], "duplicate option combination");
      combos.add(combo);
    });
  });
export type Product = z.infer<typeof Product>;

/** Manual, flat, ordered list of products. */
export const Collection = z.strictObject({
  id: CollectionId,
  title: z.string().trim().min(1),
  handle: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  productIds: z
    .array(ProductId)
    .refine(names, "a product appears once per collection"),
});
export type Collection = z.infer<typeof Collection>;

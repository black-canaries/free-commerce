import {
  newId,
  Product,
  type ProductStatus,
  toTimestamp,
  type Variant,
} from "@free-commerce/schema";
import type { z } from "zod";

/** @experimental `validation_failed` names every offending field in `issues`; `conflict` is a status rule. */
export class CatalogError extends Error {
  constructor(
    readonly code: "validation_failed" | "conflict",
    readonly issues: { path: string; message: string }[],
  ) {
    super(
      `${code}: ${issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}`,
    );
    this.name = "CatalogError";
  }
}

/** @experimental Variant ids are generated when omitted. */
export type VariantInput = Omit<z.input<typeof Variant>, "id"> & {
  id?: string;
};
/** @experimental */
export type ProductInput = {
  title: string;
  handle: string;
  description?: string;
  options?: Product["options"];
  variants: VariantInput[];
};

const validate = (candidate: unknown): Product => {
  const r = Product.safeParse(candidate);
  if (r.success) return r.data;
  throw new CatalogError(
    "validation_failed",
    r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );
};

const withIds = (variants: VariantInput[], now: Date) =>
  variants.map((v) => ({ ...v, id: v.id ?? newId("var", now.getTime()) }));

/** @experimental New products start as `draft`. Throws `CatalogError` on invalid input. */
export function createProduct(input: ProductInput, now = new Date()): Product {
  const at = toTimestamp(now);
  return validate({
    ...input,
    id: newId("prod", now.getTime()),
    status: "draft",
    options: input.options ?? [],
    variants: withIds(input.variants, now),
    createdAt: at,
    updatedAt: at,
  });
}

const conflict = (message: string) =>
  new CatalogError("conflict", [{ path: "status", message }]);

/**
 * @experimental Replaces the given fields (`variants`/`options` wholesale) and revalidates the whole product.
 * Archived products are read-only.
 */
export function updateProduct(
  product: Product,
  patch: Partial<ProductInput>,
  now = new Date(),
): Product {
  if (product.status === "archived")
    throw conflict("archived products cannot be edited");
  return validate({
    ...product,
    ...patch,
    variants: patch.variants ? withIds(patch.variants, now) : product.variants,
    updatedAt: toTimestamp(now),
  });
}

const move = (
  product: Product,
  to: ProductStatus,
  from: ProductStatus[],
  now: Date,
): Product => {
  if (!from.includes(product.status))
    throw conflict(`cannot move a ${product.status} product to ${to}`);
  return { ...product, status: to, updatedAt: toTimestamp(now) };
};

/** @experimental draft to active; every variant must have at least one price. */
export function publishProduct(product: Product, now = new Date()): Product {
  const unpriced = product.variants.flatMap((v, i) =>
    v.prices.length === 0
      ? [{ path: `variants.${i}.prices`, message: "needs a price to publish" }]
      : [],
  );
  if (unpriced.length > 0)
    throw new CatalogError("validation_failed", unpriced);
  return move(product, "active", ["draft"], now);
}

/** @experimental draft or active to archived (terminal). */
export function archiveProduct(product: Product, now = new Date()): Product {
  return move(product, "archived", ["draft", "active"], now);
}

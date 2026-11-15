import type { Product, SearchQuery, Variant } from "@free-commerce/schema";
import type { Page } from "../repositories";

/** @experimental What a search backend stores per product: only what filters, sorting and ranking need. */
export type SearchDoc = {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  collectionIds: string[];
  /** Option name to every value a variant offers. */
  options: Record<string, string[]>;
  deliveryTypes: string[];
  /** Per currency, the lowest and highest price across variants (bounds count for `customer_defined`). */
  prices: Record<string, { min: number; max: number }>;
  /** Whether any variant can be bought now; the caller derives it from inventory. */
  available: boolean;
};

/**
 * @experimental Catalog search behind a provider interface (ADR 0007). Backends are eventually
 * consistent with the catalog: the caller indexes after each product change. `search` returns product
 * ids; the caller loads the products. Cursors are opaque; results are stable for a fixed index
 * (ties break on id).
 */
export interface SearchProvider {
  /** Insert or replace by `doc.id`. */
  index(doc: SearchDoc): Promise<void>;
  /** Idempotent: unknown ids are ignored. */
  remove(id: string): Promise<void>;
  /** `q` terms must all match whole words of title or description; titles rank above descriptions. */
  search(query: SearchQuery): Promise<Page<string>>;
}

function optionsOf(variants: Variant[]): SearchDoc["options"] {
  const options: SearchDoc["options"] = {};
  for (const v of variants)
    for (const [k, val] of Object.entries(v.optionValues))
      options[k] = [...new Set([...(options[k] ?? []), val])];
  return options;
}

function pricesOf(variants: Variant[]): SearchDoc["prices"] {
  const prices: SearchDoc["prices"] = {};
  for (const p of variants.flatMap((v) => v.prices)) {
    const lo = "amount" in p ? p.amount : p.min;
    const hi = "amount" in p ? p.amount : p.max;
    const cur = prices[p.currency];
    prices[p.currency] = {
      min: Math.min(cur?.min ?? lo, lo),
      max: Math.max(cur?.max ?? hi, hi),
    };
  }
  return prices;
}

/** Search document for a product, or `null` when it must not be searchable (not `active`). */
export function toSearchDoc(
  product: Product,
  collectionIds: string[],
  available: boolean,
): SearchDoc | null {
  if (product.status !== "active") return null;
  return {
    id: product.id,
    title: product.title,
    ...(product.description !== undefined && {
      description: product.description,
    }),
    createdAt: product.createdAt,
    collectionIds,
    options: optionsOf(product.variants),
    deliveryTypes: [...new Set(product.variants.map((v) => v.deliveryType))],
    prices: pricesOf(product.variants),
    available,
  };
}

/** Cursor for offset paging (opaque to clients); malformed cursors read as the first page. */
export const offsetOf = (cursor?: string): number => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

import type { SearchQuery } from "@free-commerce/schema";
import { offsetOf, type SearchDoc, type SearchProvider } from "./search";

const words = (s = ""): string[] =>
  s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Relevance: each term scores 2 in the title, 1 in the description; `null` when any term is missing. */
function score(d: SearchDoc, terms: string[]): number | null {
  const title = words(d.title);
  const body = words(d.description);
  let total = 0;
  for (const t of terms) {
    if (title.includes(t)) total += 2;
    else if (body.includes(t)) total += 1;
    else return null;
  }
  return total;
}

function matches(d: SearchDoc, q: SearchQuery): boolean {
  const range = q.currency ? d.prices[q.currency] : undefined;
  return (
    (q.collectionId === undefined ||
      d.collectionIds.includes(q.collectionId)) &&
    Object.entries(q.options ?? {}).every(([name, vals]) =>
      vals.some((v) => d.options[name]?.includes(v)),
    ) &&
    (q.available === undefined || d.available === q.available) &&
    (q.deliveryType === undefined ||
      d.deliveryTypes.includes(q.deliveryType)) &&
    (!q.price ||
      (range !== undefined &&
        range.min <= (q.price.max ?? Number.POSITIVE_INFINITY) &&
        range.max >= (q.price.min ?? 0)))
  );
}

/** @experimental In-memory `SearchProvider` for tests and demos. */
export function createFakeSearch(): SearchProvider {
  const docs = new Map<string, SearchDoc>();
  return {
    async index(doc) {
      docs.set(doc.id, doc);
    },
    async remove(id) {
      docs.delete(id);
    },
    async search(q) {
      const terms = words(q.q);
      const hits = [...docs.values()]
        .filter((d) => matches(d, q))
        .map((d) => ({ d, rank: terms.length ? score(d, terms) : 0 }))
        .filter((h): h is Hit => h.rank !== null);
      // Products without a price in the currency sort last in both directions.
      const byPrice = (dir: 1 | -1) => (a: Hit, b: Hit) => {
        const key = (h: Hit) => {
          const p = h.d.prices[q.currency ?? ""]?.min;
          return p === undefined ? Number.POSITIVE_INFINITY : p * dir;
        };
        return cmp(key(a), key(b)) || idOrder(a, b);
      };
      const sort = q.sort === "relevance" && !terms.length ? "newest" : q.sort;
      const order = {
        relevance: (a: Hit, b: Hit) => b.rank - a.rank || newest(a, b),
        newest,
        price_asc: byPrice(1),
        price_desc: byPrice(-1),
      }[sort];
      const ids = hits.sort(order).map((h) => h.d.id);
      const start = offsetOf(q.cursor);
      const items = ids.slice(start, start + q.limit);
      return {
        items,
        nextCursor:
          start + q.limit < ids.length ? String(start + q.limit) : null,
      };
    },
  };
}

type Hit = { d: SearchDoc; rank: number };
const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const idOrder = (a: Hit, b: Hit) => (a.d.id < b.d.id ? -1 : 1);
const newest = (a: Hit, b: Hit) =>
  a.d.createdAt === b.d.createdAt
    ? idOrder(a, b)
    : a.d.createdAt < b.d.createdAt
      ? 1
      : -1;

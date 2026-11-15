---
status: accepted
---
# Catalog search: SearchProvider with a Postgres full-text implementation

**Interface** (`packages/core/src/providers/search.ts`, ADR 0007 pattern): `index(doc)`, `remove(id)`, `search(query)` returning a page of product ids. The caller loads products and keeps the index in step (index after each product change; `toSearchDoc` yields `null` for non-`active` products, which means "remove"). Availability is computed by the caller from inventory and passed in, so providers never read other modules. Fake: `createFakeSearch`; conformance: `searchConformance`, run by the fake and by Postgres.

**Query** (`SearchQuery` in `schema`, so the later endpoint reuses it): `q`, `collectionId`, `options` (any-of per option name, all names must match), inclusive `price` range plus the `currency` it applies to, `available`, `deliveryType`, `sort` (`relevance` | `newest` | `price_asc` | `price_desc`) and the shared `PageQuery`. Price is a product-level range (lowest to highest variant price, bounds for `customer_defined`); a product matches when its range overlaps the filter. Price sorts use the lowest price; products without a price in the currency sort last.

**Postgres**: one `product_search` table (migration `search/0001_init.sql`) with a stored `tsvector` (title weight A, description B), GIN indexes on text, collections and option tokens. Config is `simple`: no stemming, no language assumption (a store can be in any language); prefix search and stemming are out of scope until a real store needs them. Text goes through `websearch_to_tsquery`, so quotes/`or`/`-` work on Postgres only; the contract is "all terms match whole words".

**Cursors are offsets** (opaque to clients). Keyset paging would need a per-sort cursor encoding; offset is exact for a stable index and cheap at catalog scale (baseline below). Revisit if deep paging over very large catalogs matters. Ties always break on `id`.

**Rejected**: searching the `products` JSON documents directly (no index-friendly filters, couples search to the aggregate's storage); a separate Postgres search extension (extra dependency and ops for no gain at this scale).

## Baseline (not a CI gate)

10,000 seeded products, Postgres 17 (alpine, Docker), Apple M2, 50 runs after warm-up, 20 results per page. Reproduce: `SEARCH_BENCH=1 pnpm --filter @free-commerce/adapter-postgres test` with `TEST_DATABASE_URL` set.

| Query | p50 | p95 |
| --- | --- | --- |
| text (`ceramic mug`) | 1.3 ms | 1.7 ms |
| text + option + availability + price filters | 0.8 ms | 0.9 ms |
| filters, `price_asc` | 1.9 ms | 2.4 ms |
| `newest`, offset 9,000 | 3.3 ms | 4.7 ms |

Bulk seed of 10,000 rows (one `INSERT ... SELECT`): about 100 ms.

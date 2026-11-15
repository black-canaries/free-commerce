import { searchConformance } from "@free-commerce/core/testing";
import { SearchQuery } from "@free-commerce/schema";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { createPostgresSearch } from "./search";

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  // CI must never silently skip: the Postgres suite is required there.
  if (process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI");
  describe.skip("SearchProvider conformance: postgres", () => {
    it("skipped: set TEST_DATABASE_URL (see index.test.ts)", () => {});
  });
} else {
  const client = postgres(url, { onnotice: () => {} });
  afterAll(() => client.end());
  const make = async () => {
    await migrate(client);
    await client`truncate product_search`;
    return createPostgresSearch(client);
  };
  searchConformance("postgres", make);

  // Baseline for ADR 0025, not a gate: SEARCH_BENCH=1 pnpm --filter @free-commerce/adapter-postgres test
  it.runIf(process.env.SEARCH_BENCH)(
    "baseline: 10,000 products",
    async () => {
      const s = await make();
      const t0 = performance.now();
      await client`
      insert into product_search select
        'prod_' || lpad(n::text, 8, '0'), '2026-01-01T00:00:00.000Z', array['col_' || (n % 20)],
        array[json_build_array('Size', (array['S','M','L'])[n % 3 + 1])::text],
        array['physical'], jsonb_build_object('USD', jsonb_build_object('min', n % 500 * 100, 'max', n % 500 * 100)),
        n % 4 > 0,
        setweight(to_tsvector('simple', (array['mug','tee','bowl','lamp','print','blue','red','ceramic','linen','oak'])[n % 10 + 1]
          || ' ' || (array['blue','red','ceramic','linen','oak','mug','tee','bowl','lamp','print'])[n % 7 + 1]), 'A')
      from generate_series(1, 10000) n`;
      await client`analyze product_search`;
      console.log(`seed 10k: ${Math.round(performance.now() - t0)}ms`);
      const run = async (label: string, query: Record<string, unknown>) => {
        const q = SearchQuery.parse(query);
        await s.search(q);
        const times: number[] = [];
        for (let i = 0; i < 50; i++) {
          const t = performance.now();
          await s.search(q);
          times.push(performance.now() - t);
        }
        times.sort((a, b) => a - b);
        console.log(
          `${label}: p50 ${times[25]?.toFixed(1)}ms p95 ${times[47]?.toFixed(1)}ms`,
        );
      };
      await run("text", { q: "ceramic mug" });
      await run("text+filters", {
        q: "blue",
        options: { Size: ["M"] },
        available: true,
        currency: "USD",
        price: { max: 20000 },
      });
      await run("filters, price sort", {
        currency: "USD",
        sort: "price_asc",
        available: true,
      });
      await run("deep page", { sort: "newest", cursor: "9000" });
      expect(true).toBe(true);
    },
    120_000,
  );
}

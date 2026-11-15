import { SearchQuery } from "@free-commerce/schema";
import { describe, expect, it } from "vitest";
import type { SearchDoc, SearchProvider } from "./search";

const doc = (n: number, over: Partial<SearchDoc> = {}): SearchDoc => ({
  id: `prod_${n}`,
  title: `Item ${n}`,
  createdAt: `2026-01-0${n}T00:00:00.000Z`,
  collectionIds: [],
  options: {},
  deliveryTypes: ["physical"],
  prices: { USD: { min: n * 1000, max: n * 1000 } },
  available: true,
  ...over,
});
const COL = `col_${"0".repeat(25)}A`;
const q = (query: Record<string, unknown> = {}) => SearchQuery.parse(query);

/** @experimental Every `SearchProvider` adapter (fake or real) must pass this. */
export function searchConformance(
  name: string,
  make: () => Promise<SearchProvider> | SearchProvider,
): void {
  describe(`SearchProvider conformance: ${name}`, () => {
    const seeded = async (...docs: SearchDoc[]) => {
      const s = await make();
      for (const d of docs) await s.index(d);
      return async (query?: Record<string, unknown>) =>
        (await s.search(q(query))).items;
    };

    it("ranks title matches above description matches and requires every term", async () => {
      const find = await seeded(
        doc(1, { title: "Blue mug", description: "ceramic" }),
        doc(2, { title: "Ceramic bowl blue" }),
        doc(3, { title: "Plate", description: "ceramic and blue glaze" }),
        doc(4, { title: "Red mug", description: "ceramic" }),
      );
      expect(await find({ q: "ceramic blue" })).toEqual([
        "prod_2",
        "prod_1",
        "prod_3",
      ]);
      expect(await find({ q: "CERAMIC" })).toHaveLength(4);
      expect(await find({ q: "nothing" })).toEqual([]);
    });

    it("filters by collection, option values, availability and delivery type", async () => {
      const find = await seeded(
        doc(1, { collectionIds: [COL], options: { Size: ["S", "M"] } }),
        doc(2, { options: { Size: ["L"], Colour: ["Red"] }, available: false }),
        doc(3, { deliveryTypes: ["digital"], collectionIds: [COL] }),
      );
      expect(await find({ collectionId: COL, sort: "newest" })).toEqual([
        "prod_3",
        "prod_1",
      ]);
      expect(await find({ options: { Size: ["M", "L"] } })).toEqual([
        "prod_2",
        "prod_1",
      ]);
      expect(await find({ options: { Size: ["L"], Colour: ["Red"] } })).toEqual(
        ["prod_2"],
      );
      expect(
        await find({ options: { Size: ["L"], Colour: ["Blue"] } }),
      ).toEqual([]);
      expect(await find({ available: false })).toEqual(["prod_2"]);
      expect(await find({ deliveryType: "digital" })).toEqual(["prod_3"]);
    });

    it("filters by overlapping price range in one currency", async () => {
      const find = await seeded(
        doc(1),
        doc(2, { prices: { USD: { min: 500, max: 5000 } } }),
        doc(3, { prices: { EUR: { min: 3000, max: 3000 } } }),
      );
      const price = (min?: number, max?: number) =>
        find({ currency: "USD", price: { min, max }, sort: "price_asc" });
      expect(await price(1500, 2500)).toEqual(["prod_2"]);
      expect(await price(undefined, 1000)).toEqual(["prod_2", "prod_1"]);
      expect(await price(6000)).toEqual([]);
    });

    it("sorts by price and newest, with id as tiebreak", async () => {
      const find = await seeded(
        doc(1),
        doc(2, { prices: { USD: { min: 100, max: 100 } } }),
        doc(3, { prices: { USD: { min: 100, max: 100 } } }),
        doc(4, { prices: { EUR: { min: 1, max: 1 } } }),
      );
      const usd = { currency: "USD" };
      expect(await find({ ...usd, sort: "price_asc" })).toEqual([
        "prod_2",
        "prod_3",
        "prod_1",
        "prod_4",
      ]);
      expect(
        await find({ ...usd, sort: "price_desc" }).then((r) => r.slice(0, 3)),
      ).toEqual(["prod_1", "prod_2", "prod_3"]);
      expect(await find({ sort: "newest" })).toEqual([
        "prod_4",
        "prod_3",
        "prod_2",
        "prod_1",
      ]);
    });

    it("pages with opaque cursors until nextCursor is null", async () => {
      const s = await make();
      for (const n of [1, 2, 3, 4, 5]) await s.index(doc(n));
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await s.search(q({ sort: "newest", limit: 2, cursor }));
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(["prod_5", "prod_4", "prod_3", "prod_2", "prod_1"]);
    });

    it("replaces on re-index and forgets on remove, idempotently", async () => {
      const s = await make();
      await s.index(doc(1, { title: "Old name" }));
      await s.index(doc(1, { title: "New name" }));
      expect((await s.search(q({ q: "old" }))).items).toEqual([]);
      expect((await s.search(q({ q: "new" }))).items).toEqual(["prod_1"]);
      await s.remove("prod_1");
      await s.remove("prod_1");
      expect((await s.search(q())).items).toEqual([]);
    });
  });
}

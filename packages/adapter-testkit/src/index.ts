import {
  createProduct,
  type Database,
  type Entity,
  type Repository,
} from "@free-commerce/core";
import { describe, expect, it } from "vitest";

const product = (id: string, title = "Mug") => ({
  ...createProduct(
    {
      title,
      handle: "mug",
      variants: [
        {
          id: "var_00000000000000000000000000",
          optionValues: {},
          deliveryType: "physical" as const,
          priceMode: "fixed" as const,
          prices: [{ currency: "USD", amount: 1200 }],
        },
      ],
    },
    new Date(0),
  ),
  id,
});
const plain = (id: string, v = 1) => (v === 1 ? { id } : { id, v });

/** Each aggregate with a builder for a valid entity; `v` > 1 makes a distinguishable overwrite. */
const aggregates = {
  products: (id: string, v = 1) => product(id, `Mug ${v}`),
  carts: plain,
  orders: plain,
} as const;

/** @experimental Every `Database` adapter must pass this (in-memory and Postgres alike). */
export function repositoryConformance(
  name: string,
  make: () => Database,
): void {
  describe(`Database conformance: ${name}`, () => {
    for (const [kind, build] of Object.entries(aggregates)) {
      describe(kind, () => {
        const repo = (db: Database) =>
          db[kind as keyof typeof aggregates] as Repository<Entity>;

        it("round-trips and overwrites by id", async () => {
          const r = repo(make());
          await r.save(build("a"));
          await r.save(build("a", 2));
          expect(await r.get("a")).toEqual(build("a", 2));
        });

        it("get on a missing id resolves null", async () => {
          expect(await repo(make()).get("missing")).toBeNull();
        });

        it("lists by id with cursor pagination", async () => {
          const r = repo(make());
          for (const id of ["c", "a", "d", "b", "e"]) await r.save(build(id));
          const p1 = await r.list({ limit: 2 });
          expect(p1.items.map((i) => i.id)).toEqual(["a", "b"]);
          const p2 = await r.list({ limit: 2, cursor: p1.nextCursor ?? "" });
          expect(p2.items.map((i) => i.id)).toEqual(["c", "d"]);
          const p3 = await r.list({ limit: 2, cursor: p2.nextCursor ?? "" });
          expect(p3).toEqual({ items: [build("e")], nextCursor: null });
        });
      });
    }

    it("commits transaction writes and returns the result", async () => {
      const db = make();
      const out = await db.transaction(async (tx) => {
        await tx.products.save(product("p"));
        await tx.orders.save(plain("o"));
        return 42;
      });
      expect(out).toBe(42);
      expect(await db.products.get("p")).toEqual(product("p"));
      expect(await db.orders.get("o")).toEqual(plain("o"));
    });

    it("rolls back every write and rethrows when the transaction throws", async () => {
      const db = make();
      await db.products.save(product("keep"));
      const boom = new Error("boom");
      await expect(
        db.transaction(async (tx) => {
          await tx.products.save(product("keep", "Changed"));
          await tx.carts.save(plain("c"));
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await db.products.get("keep")).toEqual(product("keep"));
      expect(await db.carts.get("c")).toBeNull();
    });
  });
}

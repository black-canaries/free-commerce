import type { Database, Entity, Repository } from "@free-commerce/core";
import { describe, expect, it } from "vitest";

const aggregates = ["products", "carts", "orders"] as const;

/** @experimental Every `Database` adapter must pass this (in-memory and Postgres alike). */
export function repositoryConformance(
  name: string,
  make: () => Database,
): void {
  describe(`Database conformance: ${name}`, () => {
    for (const kind of aggregates) {
      describe(kind, () => {
        const repo = (db: { [K in typeof kind]: Repository<Entity> }) =>
          db[kind];

        it("round-trips and overwrites by id", async () => {
          const r = repo(make());
          await r.save({ id: "a" });
          await r.save({ id: "a", v: 2 } as Entity);
          expect(await r.get("a")).toEqual({ id: "a", v: 2 });
        });

        it("get on a missing id resolves null", async () => {
          expect(await repo(make()).get("missing")).toBeNull();
        });

        it("lists by id with cursor pagination", async () => {
          const r = repo(make());
          for (const id of ["c", "a", "d", "b", "e"]) await r.save({ id });
          const p1 = await r.list({ limit: 2 });
          expect(p1.items.map((i) => i.id)).toEqual(["a", "b"]);
          const p2 = await r.list({ limit: 2, cursor: p1.nextCursor ?? "" });
          expect(p2.items.map((i) => i.id)).toEqual(["c", "d"]);
          const p3 = await r.list({ limit: 2, cursor: p2.nextCursor ?? "" });
          expect(p3).toEqual({ items: [{ id: "e" }], nextCursor: null });
        });
      });
    }

    it("commits transaction writes and returns the result", async () => {
      const db = make();
      const out = await db.transaction(async (tx) => {
        await tx.products.save({ id: "p" });
        await tx.orders.save({ id: "o" });
        return 42;
      });
      expect(out).toBe(42);
      expect(await db.products.get("p")).toEqual({ id: "p" });
      expect(await db.orders.get("o")).toEqual({ id: "o" });
    });

    it("rolls back every write and rethrows when the transaction throws", async () => {
      const db = make();
      await db.products.save({ id: "keep" });
      const boom = new Error("boom");
      await expect(
        db.transaction(async (tx) => {
          await tx.products.save({ id: "keep", v: 2 } as Entity);
          await tx.carts.save({ id: "c" });
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await db.products.get("keep")).toEqual({ id: "keep" });
      expect(await db.carts.get("c")).toBeNull();
    });
  });
}

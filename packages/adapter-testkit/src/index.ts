import {
  createEventBus,
  createProduct,
  type Database,
  type DomainEvent,
  type Entity,
  idempotent,
  type Repository,
  relayOutbox,
} from "@free-commerce/core";
import { describe, expect, it } from "vitest";
import { auditCases } from "./audit";
import { discountCases } from "./discounts";
import { inventoryCases } from "./inventory";

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
  roles: (id: string, v = 1) => ({
    id,
    role: v === 1 ? ("staff" as const) : ("owner" as const),
  }),
  discounts: (id: string, v = 1) => ({ id, code: `CODE-${id}`, v }),
} as const;

/** @experimental Every `Database` adapter must pass this (in-memory and Postgres alike). */
export function repositoryConformance(
  name: string,
  make: () => Database | Promise<Database>,
): void {
  describe(`Database conformance: ${name}`, () => {
    for (const [kind, build] of Object.entries(aggregates)) {
      describe(kind, () => {
        const repo = (db: Database) =>
          db[kind as keyof typeof aggregates] as Repository<Entity>;

        it("round-trips and overwrites by id", async () => {
          const r = repo(await make());
          await r.save(build("a"));
          await r.save(build("a", 2));
          expect(await r.get("a")).toEqual(build("a", 2));
        });

        it("get on a missing id resolves null", async () => {
          expect(await repo(await make()).get("missing")).toBeNull();
        });

        it("lists by id with cursor pagination", async () => {
          const r = repo(await make());
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

    inventoryCases(make);
    discountCases(make);
    auditCases(make);

    it("commits transaction writes and returns the result", async () => {
      const db = await make();
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
      const db = await make();
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

    it("serialises concurrent transactions (no lost updates)", async () => {
      const db = await make();
      const counter = (count: number) => ({ id: "n", count }) as Entity;
      await db.orders.save(counter(0));
      const bump = () =>
        db.transaction(async (tx) => {
          const row = (await tx.orders.get("n")) as unknown as {
            count: number;
          };
          await tx.orders.save(counter(row.count + 1));
        });
      await Promise.all(Array.from({ length: 10 }, bump));
      expect(await db.orders.get("n")).toEqual(counter(10));
    });
  });
}

const evt = (id: string): DomainEvent => ({
  id,
  type: "t",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: { id },
});

/** @experimental Outbox and relay behaviour every `Database` adapter must pass. */
export function outboxConformance(
  name: string,
  make: () => Database | Promise<Database>,
): void {
  describe(`Outbox conformance: ${name}`, () => {
    const ids = async (db: Database) =>
      (await db.outbox.pending(10)).map((e) => e.id);

    it("keeps insertion order, ignores duplicate ids, honours the limit", async () => {
      const db = await make();
      for (const id of ["b", "a", "c", "a"]) await db.outbox.add(evt(id));
      expect(await ids(db)).toEqual(["b", "a", "c"]);
      expect(await db.outbox.pending(2)).toEqual([evt("b"), evt("a")]);
    });

    it("markDelivered removes from pending and is idempotent", async () => {
      const db = await make();
      await db.outbox.add(evt("a"));
      await db.outbox.add(evt("b"));
      await db.outbox.markDelivered("a");
      await db.outbox.markDelivered("a");
      await db.outbox.add(evt("a")); // re-adding a delivered id stays delivered
      expect(await ids(db)).toEqual(["b"]);
    });

    it("commits events with the domain change and drops them on rollback", async () => {
      const db = await make();
      await db.transaction(async (tx) => {
        await tx.orders.save({ id: "o1" });
        await tx.outbox.add(evt("kept"));
      });
      await expect(
        db.transaction(async (tx) => {
          await tx.orders.save({ id: "o2" });
          await tx.outbox.add(evt("lost"));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await ids(db)).toEqual(["kept"]);
      expect(await db.orders.get("o2")).toBeNull();
    });

    it("relay: a failing handler stops the batch, earlier events stay delivered, retry resumes", async () => {
      const db = await make();
      for (const id of ["1", "2", "3"]) await db.outbox.add(evt(id));
      const got: string[] = [];
      let broken = true;
      const bus = createEventBus();
      bus.subscribe("t", async (e) => {
        if (e.id === "2" && broken) throw new Error("crash");
        got.push(e.id);
      });
      await expect(relayOutbox(db.outbox, bus)).rejects.toThrow("crash");
      expect(await ids(db)).toEqual(["2", "3"]);
      broken = false;
      expect(await relayOutbox(db.outbox, bus)).toBe(2);
      expect(got).toEqual(["1", "2", "3"]);
      expect(await relayOutbox(db.outbox, bus)).toBe(0);
    });

    it("relay: a crash after publish but before marking redelivers; idempotent subscribers apply once", async () => {
      const db = await make();
      await db.outbox.add(evt("1"));
      const effects: string[] = [];
      const seen = new Set<string>();
      const bus = createEventBus();
      bus.subscribe(
        "t",
        idempotent(seen, async (e) => void effects.push(e.id)),
      );
      let crash = true;
      const flaky = {
        ...db.outbox,
        async markDelivered(id: string) {
          if (crash) {
            crash = false;
            throw new Error("died before marking");
          }
          return db.outbox.markDelivered(id);
        },
      };
      await expect(relayOutbox(flaky, bus)).rejects.toThrow("died");
      expect(await ids(db)).toEqual(["1"]);
      await relayOutbox(flaky, bus);
      expect(await ids(db)).toEqual([]);
      expect(effects).toEqual(["1"]);
    });

    it("bus runs every handler even when one fails", async () => {
      const bus = createEventBus();
      const ran: string[] = [];
      bus.subscribe("t", async () => {
        throw new Error("first");
      });
      bus.subscribe("t", async () => void ran.push("second"));
      await expect(bus.publish(evt("1"))).rejects.toThrow("first");
      expect(ran).toEqual(["second"]);
    });
  });
}

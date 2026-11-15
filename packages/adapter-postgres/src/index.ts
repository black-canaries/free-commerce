import {
  type Database,
  decideReserveRetry,
  decideSettle,
  type Entity,
  type InventoryRepository,
  type Page,
  type Repositories,
  type Repository,
} from "@free-commerce/core";
import { type Reservation, toTimestamp } from "@free-commerce/schema";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

/** One table per module, named like its `Repositories` key; adding a repository = one entry here plus its `migrations/<module>/` folder. */
const tables = {
  products: docTable("products"),
  carts: docTable("carts"),
  orders: docTable("orders"),
} satisfies Record<Exclude<keyof Repositories, "inventory">, unknown>;

/** Aggregates are stored whole as JSON documents keyed by id (ADR 0017). */
function docTable(name: string) {
  return pgTable(name, {
    id: text("id").primaryKey(),
    doc: jsonb("doc").notNull(),
  });
}

const stock = pgTable("stock", {
  variantId: text("variant_id").primaryKey(),
  quantity: integer("quantity").notNull(),
});
const reservations = pgTable("reservations", {
  id: text("id").primaryKey(),
  variantId: text("variant_id").notNull(),
  cartId: text("cart_id").notNull(),
  quantity: integer("quantity").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: text("status").$type<Reservation["status"]>().notNull(),
});

type Db = Pick<
  ReturnType<typeof drizzle>,
  "select" | "insert" | "update" | "execute" | "transaction"
>;

const repository = <T extends Entity>(
  db: Db,
  table: (typeof tables)[keyof typeof tables],
): Repository<T> => ({
  async get(id) {
    const [row] = await db
      .select({ doc: table.doc })
      .from(table)
      .where(eq(table.id, id));
    return (row?.doc as T | undefined) ?? null;
  },
  async save(entity) {
    const doc = entity as unknown;
    await db
      .insert(table)
      .values({ id: entity.id, doc })
      .onConflictDoUpdate({ target: table.id, set: { doc } });
  },
  async list({ cursor, limit }): Promise<Page<T>> {
    const rows = await db
      .select({ id: table.id, doc: table.doc })
      .from(table)
      .where(cursor === undefined ? undefined : gt(table.id, cursor))
      .orderBy(asc(table.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => r.doc as T),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  },
});

const toReservation = (r: typeof reservations.$inferSelect): Reservation => ({
  ...r,
  expiresAt: toTimestamp(r.expiresAt),
});

/**
 * Inventory has real columns (ADR 0017). Every write runs in a transaction holding a per-variant
 * advisory lock, so check-then-write is serialised per variant under READ COMMITTED (ADR 0016).
 */
const inventory = (db: Db): InventoryRepository => {
  const atomic = <R>(variantId: string, fn: (tx: Db) => Promise<R>) =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${variantId}, 7243003))`,
      );
      return fn(tx);
    });
  const find = async (q: Db, id: string) => {
    const [row] = await q
      .select()
      .from(reservations)
      .where(eq(reservations.id, id));
    return row && toReservation(row);
  };
  const onHand = async (q: Db, variantId: string) => {
    const [row] = await q
      .select()
      .from(stock)
      .where(eq(stock.variantId, variantId));
    return row?.quantity ?? 0;
  };
  const held = async (q: Db, variantId: string, now: string) => {
    const [row] = await q
      .select({
        n: sql<number>`coalesce(sum(${reservations.quantity}), 0)::int`,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.variantId, variantId),
          eq(reservations.status, "active"),
          gt(reservations.expiresAt, new Date(now)),
        ),
      );
    return row?.n ?? 0;
  };
  return {
    async getStock(variantId) {
      const [row] = await db
        .select()
        .from(stock)
        .where(eq(stock.variantId, variantId));
      return row ?? null;
    },
    async setStock(level) {
      await db
        .insert(stock)
        .values(level)
        .onConflictDoUpdate({
          target: stock.variantId,
          set: { quantity: level.quantity },
        });
    },
    reserved: (variantId, now) => held(db, variantId, now),
    reserve: (draft, now, allowBackorder) =>
      atomic(draft.variantId, async (tx) => {
        const stored = await find(tx, draft.id);
        if (stored) return decideReserveRetry(stored, draft, now);
        const free =
          (await onHand(tx, draft.variantId)) -
          (await held(tx, draft.variantId, now));
        if (!allowBackorder && free < draft.quantity)
          return { ok: false, reason: "insufficient" };
        await tx.insert(reservations).values({
          ...draft,
          expiresAt: new Date(draft.expiresAt),
          status: "active",
        });
        return { ok: true, reservation: { ...draft, status: "active" } };
      }),
    async settle(id, to, now) {
      const peek = await find(db, id);
      if (!peek) return { ok: false, reason: "not_found" };
      return atomic(peek.variantId, async (tx) => {
        const before = await find(tx, id);
        const out = decideSettle(before, to, now);
        if (out.ok && before && before.status !== to) {
          await tx
            .update(reservations)
            .set({ status: to })
            .where(eq(reservations.id, id));
          if (to === "committed")
            await tx
              .insert(stock)
              .values({
                variantId: before.variantId,
                quantity: -before.quantity,
              })
              .onConflictDoUpdate({
                target: stock.variantId,
                set: { quantity: sql`${stock.quantity} - ${before.quantity}` },
              });
        }
        return out;
      });
    },
  };
};

const bind = (db: Db): Repositories => ({
  inventory: inventory(db),
  products: repository(db, tables.products),
  carts: repository(db, tables.carts),
  orders: repository(db, tables.orders),
});

/** Arbitrary constant: every transaction takes this lock first, so they run one at a time. */
const TRANSACTION_LOCK = 7_243_001;

/**
 * @experimental Postgres `Database`. The caller owns the `postgres` client (and
 * its `end()`); run `migrate` from `./migrate` before first use. Transactions
 * are serialised with an advisory lock, matching the in-memory adapter.
 */
export function createPostgresDatabase(client: Sql): Database {
  const db = drizzle(client);
  return {
    ...bind(db),
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${TRANSACTION_LOCK})`,
        );
        return fn(bind(tx));
      }),
  };
}

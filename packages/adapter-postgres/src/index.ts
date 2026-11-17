import {
  type ApiKey,
  type ApiKeyStore,
  type AuditEntry,
  type AuditRepository,
  type Database,
  type DiscountRepository,
  type DomainEvent,
  decideReserveRetry,
  decideSettle,
  type Entity,
  type InventoryRepository,
  type Outbox,
  type Page,
  type Repositories,
  type Repository,
  usageRefusal,
  type WebhookDelivery,
  type WebhookDeliveryRepository,
  type WebhookEndpoint,
} from "@free-commerce/core";
import {
  type CustomerAddress,
  type DiscountCode,
  type Reservation,
  toTimestamp,
} from "@free-commerce/schema";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  bigserial,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

/** One table per module, named like its `Repositories` key; adding a repository = one entry here plus its `migrations/<module>/` folder. */
const tables = {
  products: docTable("products"),
  carts: docTable("carts"),
  orders: docTable("orders"),
  roles: docTable("roles"),
  customers: docTable("customers"),
  addresses: docTable("addresses"),
} satisfies Record<
  Exclude<
    keyof Repositories,
    | "inventory"
    | "outbox"
    | "discounts"
    | "audit"
    | "webhookEndpoints"
    | "webhookDeliveries"
  >,
  unknown
>;

/** Aggregates are stored whole as JSON documents keyed by id (ADR 0017). */
function docTable(name: string) {
  return pgTable(name, {
    id: text("id").primaryKey(),
    doc: jsonb("doc").notNull(),
  });
}

const discountTable = docTable("discounts");
const auditTable = docTable("audit");
const apiKeysTable = docTable("api_keys");
const webhookEndpointTable = docTable("webhook_endpoints");
const webhookDeliveryTable = docTable("webhook_deliveries");
const redemptions = pgTable("redemptions", {
  id: text("id").primaryKey(),
  codeId: text("code_id").notNull(),
  customerKey: text("customer_key"),
});

const stock = pgTable("stock", {
  variantId: text("variant_id").primaryKey(),
  quantity: integer("quantity").notNull(),
});
const outboxTable = pgTable("outbox", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  id: text("id").notNull().unique(),
  event: jsonb("event").notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
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
  "select" | "insert" | "update" | "delete" | "execute" | "transaction"
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

/** Owner lookups use the `customerId` expression indexes of the orders and addresses tables. */
const ownedBy = async <T>(
  db: Db,
  table: typeof tables.orders | typeof tables.addresses,
  customerId: string,
) =>
  (
    await db
      .select({ doc: table.doc })
      .from(table)
      .where(sql`${table.doc}->>'customerId' = ${customerId}`)
      .orderBy(asc(table.id))
  ).map((r) => r.doc as T);

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

/**
 * Codes are JSON documents (unique index on `doc->>'code'`); redemptions have real columns. `redeem`
 * runs in a transaction under a per-code advisory lock, so count-check-insert is serialised per code.
 */
const discounts = (db: Db): DiscountRepository => {
  const count = async (q: Db, codeId: string, key?: string) => {
    const [row] = await q
      .select({
        total: sql<number>`count(*)::int`,
        customer: sql<number>`count(*) filter (where ${redemptions.customerKey} = ${key ?? null})::int`,
      })
      .from(redemptions)
      .where(eq(redemptions.codeId, codeId));
    return { total: row?.total ?? 0, customer: row?.customer ?? 0 };
  };
  return {
    ...repository<DiscountCode>(db, discountTable),
    async getByCode(code) {
      const [row] = await db
        .select({ doc: discountTable.doc })
        .from(discountTable)
        .where(sql`${discountTable.doc}->>'code' = ${code}`);
      return (row?.doc as DiscountCode | undefined) ?? null;
    },
    usage: (codeId, key) => count(db, codeId, key),
    redeem: (codeId, redemptionId, customerKey) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${codeId}, 7243004))`,
        );
        const [row] = await tx
          .select({ doc: discountTable.doc })
          .from(discountTable)
          .where(eq(discountTable.id, codeId));
        const code = row?.doc as DiscountCode | undefined;
        if (!code) return { ok: false, reason: "not_found" } as const;
        const [seen] = await tx
          .select({ id: redemptions.id })
          .from(redemptions)
          .where(eq(redemptions.id, redemptionId));
        if (seen) return { ok: true } as const;
        const n = await count(tx, codeId, customerKey);
        const no = usageRefusal(code, n, customerKey);
        if (no) return { ok: false, reason: no } as const;
        await tx
          .insert(redemptions)
          .values({ id: redemptionId, codeId, customerKey });
        return { ok: true } as const;
      }),
    async release(redemptionId) {
      await db.delete(redemptions).where(eq(redemptions.id, redemptionId));
    },
  };
};

/** Append-only JSON documents; ids sort by time, so newest-first is `id desc`. */
const audit = (db: Db): AuditRepository => ({
  async append(entry) {
    await db
      .insert(auditTable)
      .values({ id: entry.id, doc: entry })
      .onConflictDoNothing({ target: auditTable.id });
  },
  async list({ limit, cursor, actorId }) {
    const rows = await db
      .select({ doc: auditTable.doc })
      .from(auditTable)
      .where(
        and(
          cursor === undefined ? undefined : lt(auditTable.id, cursor),
          actorId === undefined
            ? undefined
            : sql`${auditTable.doc}->'actor'->>'id' = ${actorId}`,
        ),
      )
      .orderBy(desc(auditTable.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map((r) => r.doc as AuditEntry);
    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  },
});

/**
 * API keys are JSON documents (ADR 0019). The unique index on `doc->>'hash'` makes a duplicate secret
 * hash impossible; lookup by hash is that index. Not part of `Database`: keys are not domain data and
 * need no transaction with it.
 */
export const createPostgresApiKeyStore = (client: Sql): ApiKeyStore => {
  const db = drizzle(client);
  const { get, save, list } = repository<ApiKey>(db, apiKeysTable);
  return {
    get,
    save,
    list,
    async getByHash(hash) {
      const [row] = await db
        .select({ doc: apiKeysTable.doc })
        .from(apiKeysTable)
        .where(sql`${apiKeysTable.doc}->>'hash' = ${hash}`);
      return (row?.doc as ApiKey | undefined) ?? null;
    },
  };
};

/** JSON documents; `due` and `listFor` use the partial/expression indexes in the `webhooks` migration. */
const webhookDeliveries = (db: Db): WebhookDeliveryRepository => {
  const t = webhookDeliveryTable;
  return {
    ...repository<WebhookDelivery>(db, t),
    async create(delivery) {
      await db
        .insert(t)
        .values({ id: delivery.id, doc: delivery })
        .onConflictDoNothing({ target: t.id });
    },
    async due(now, limit) {
      const rows = await db
        .select({ doc: t.doc })
        .from(t)
        .where(
          sql`${t.doc}->>'status' = 'pending' and (${t.doc}->>'nextAttemptAt') collate "C" <= ${now}`,
        )
        .orderBy(sql`(${t.doc}->>'nextAttemptAt') collate "C"`, asc(t.id))
        .limit(limit);
      return rows.map((r) => r.doc as WebhookDelivery);
    },
    async listFor(endpointId, { limit, cursor }) {
      const rows = await db
        .select({ doc: t.doc })
        .from(t)
        .where(
          and(
            sql`${t.doc}->>'endpointId' = ${endpointId}`,
            cursor === undefined ? undefined : lt(t.id, cursor),
          ),
        )
        .orderBy(desc(t.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map((r) => r.doc as WebhookDelivery);
      return {
        items,
        nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
      };
    },
  };
};

const outbox = (db: Db): Outbox => ({
  async add(event) {
    await db
      .insert(outboxTable)
      .values({ id: event.id, event })
      .onConflictDoNothing({ target: outboxTable.id });
  },
  async pending(limit) {
    const rows = await db
      .select({ event: outboxTable.event })
      .from(outboxTable)
      .where(isNull(outboxTable.deliveredAt))
      .orderBy(asc(outboxTable.seq))
      .limit(limit);
    return rows.map((r) => r.event as DomainEvent);
  },
  async markDelivered(id) {
    await db
      .update(outboxTable)
      .set({ deliveredAt: sql`now()` })
      .where(eq(outboxTable.id, id));
  },
});

const bind = (db: Db): Repositories => ({
  inventory: inventory(db),
  discounts: discounts(db),
  products: repository(db, tables.products),
  carts: repository(db, tables.carts),
  customers: repository(db, tables.customers),
  addresses: {
    ...repository<CustomerAddress>(db, tables.addresses),
    listByCustomer: (id) => ownedBy(db, tables.addresses, id),
    async deleteByCustomer(id) {
      await db
        .delete(tables.addresses)
        .where(sql`${tables.addresses.doc}->>'customerId' = ${id}`);
    },
  },
  orders: {
    ...repository(db, tables.orders),
    listByCustomer: (id) => ownedBy(db, tables.orders, id),
  },
  roles: repository(db, tables.roles),
  audit: audit(db),
  webhookEndpoints: repository<WebhookEndpoint>(db, webhookEndpointTable),
  webhookDeliveries: webhookDeliveries(db),
  outbox: outbox(db),
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

export { createPostgresSearch } from "./search";

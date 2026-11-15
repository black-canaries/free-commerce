import type {
  Database,
  Entity,
  Page,
  Repositories,
  Repository,
} from "@free-commerce/core";
import { asc, eq, gt, sql } from "drizzle-orm";
import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

/** One table per module, named like its `Repositories` key; adding a repository = one entry here plus its `migrations/<module>/` folder. */
const tables = {
  products: docTable("products"),
  carts: docTable("carts"),
  orders: docTable("orders"),
} satisfies Record<keyof Repositories, unknown>;

/** Aggregates are stored whole as JSON documents keyed by id (ADR 0017). */
function docTable(name: string) {
  return pgTable(name, {
    id: text("id").primaryKey(),
    doc: jsonb("doc").notNull(),
  });
}

type Db = Pick<ReturnType<typeof drizzle>, "select" | "insert">;

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

const bind = (db: Db): Repositories => ({
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

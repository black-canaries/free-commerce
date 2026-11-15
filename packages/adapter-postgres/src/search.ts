import {
  offsetOf,
  type SearchDoc,
  type SearchProvider,
} from "@free-commerce/core";
import type { SearchQuery } from "@free-commerce/schema";
import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

/** One token per option name/value pair; JSON keeps any characters in names unambiguous. */
const token = (name: string, value: string) => JSON.stringify([name, value]);
const textArray = (xs: string[]) =>
  xs.length
    ? sql`array[${sql.join(
        xs.map((x) => sql`${x}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;

/**
 * @experimental Postgres full-text `SearchProvider` (ADR 0025): a `product_search` table with a stored
 * `tsvector` (title weight A, description B, `simple` config), GIN indexes, and offset cursors. Terms go
 * through `websearch_to_tsquery`, so quotes, `or` and `-` also work here. Run `migrate` first.
 */
export function createPostgresSearch(client: Sql): SearchProvider {
  const db = drizzle(client);
  return {
    async index(d: SearchDoc) {
      const tokens = Object.entries(d.options).flatMap(([n, vs]) =>
        vs.map((v) => token(n, v)),
      );
      await db.execute(sql`
        insert into product_search
          (id, created_at, collection_ids, option_tokens, delivery_types, prices, available, tsv)
        values (${d.id}, ${d.createdAt}, ${textArray(d.collectionIds)}, ${textArray(tokens)},
          ${textArray(d.deliveryTypes)}, ${JSON.stringify(d.prices)}::jsonb, ${d.available},
          setweight(to_tsvector('simple', ${d.title}), 'A') ||
          setweight(to_tsvector('simple', ${d.description ?? ""}), 'B'))
        on conflict (id) do update set
          created_at = excluded.created_at, collection_ids = excluded.collection_ids,
          option_tokens = excluded.option_tokens, delivery_types = excluded.delivery_types,
          prices = excluded.prices, available = excluded.available, tsv = excluded.tsv`);
    },
    async remove(id) {
      await db.execute(sql`delete from product_search where id = ${id}`);
    },
    async search(q) {
      const text = q.q?.trim() ? q.q : undefined;
      const tsq = sql`websearch_to_tsquery('simple', ${text ?? ""})`;
      const where = filters(q, text ? tsq : undefined);
      const offset = offsetOf(q.cursor);
      const rows = await db.execute<{ id: string }>(sql`
        select id from product_search
        ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
        order by ${orderBy(q, text ? tsq : undefined)} limit ${q.limit + 1} offset ${offset}`);
      const items = rows.slice(0, q.limit).map((r) => r.id);
      return {
        items,
        nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
      };
    },
  };
}

const price = (q: SearchQuery, bound: "min" | "max") =>
  sql`(prices -> ${q.currency ?? ""} ->> ${bound})::bigint`;

function filters(q: SearchQuery, tsq: SQL | undefined): SQL[] {
  const where: SQL[] = [];
  if (tsq) where.push(sql`tsv @@ ${tsq}`);
  if (q.collectionId) where.push(sql`${q.collectionId} = any(collection_ids)`);
  for (const [name, values] of Object.entries(q.options ?? {}))
    where.push(
      sql`option_tokens && ${textArray(values.map((v) => token(name, v)))}`,
    );
  if (q.available !== undefined) where.push(sql`available = ${q.available}`);
  if (q.deliveryType) where.push(sql`${q.deliveryType} = any(delivery_types)`);
  if (q.price) {
    where.push(sql`${price(q, "min")} is not null`);
    if (q.price.max !== undefined)
      where.push(sql`${price(q, "min")} <= ${q.price.max}`);
    if (q.price.min !== undefined)
      where.push(sql`${price(q, "max")} >= ${q.price.min}`);
  }
  return where;
}

function orderBy(q: SearchQuery, tsq: SQL | undefined): SQL {
  if (q.sort === "relevance" && tsq) return sql`ts_rank(tsv, ${tsq}) desc, id`;
  if (q.sort === "price_asc") return sql`${price(q, "min")} asc nulls last, id`;
  if (q.sort === "price_desc")
    return sql`${price(q, "min")} desc nulls last, id`;
  return sql`created_at desc, id`;
}

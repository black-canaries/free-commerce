import type { PageQuery, Product } from "@free-commerce/schema";

/** @experimental Placeholder entity shape; Phase 1 replaces it with the real Zod-derived types. */
export type Entity = { id: string };

/** @experimental Cursor page; same shape as the schema package's `pageOf`. */
export type Page<T> = { items: T[]; nextCursor: string | null };

/** @experimental Minimal persistence contract shared by all aggregates. */
export interface Repository<T extends Entity> {
  /** Resolves `null` when the id does not exist. */
  get(id: string): Promise<T | null>;
  /** Insert or replace by `id`. */
  save(entity: T): Promise<void>;
  /** Ordered by `id` ascending; `nextCursor` is null on the last page. */
  list(query: PageQuery): Promise<Page<T>>;
}

/** @experimental */
export type ProductRepository = Repository<Product>;
/** @experimental */
export type CartRepository<T extends Entity = Entity> = Repository<T>;
/** @experimental */
export type OrderRepository<T extends Entity = Entity> = Repository<T>;

/** @experimental */
export interface Repositories {
  products: ProductRepository;
  carts: CartRepository;
  orders: OrderRepository;
}

/**
 * @experimental Repositories plus atomic units of work. `transaction` runs `fn`
 * against transaction-bound repositories: all writes commit if `fn` resolves,
 * none persist if it throws (the error is rethrown). Transactions do not nest and
 * must not use the outer repositories.
 */
export interface Database extends Repositories {
  transaction<R>(fn: (tx: Repositories) => Promise<R>): Promise<R>;
}

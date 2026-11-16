import type {
  DigitalAsset,
  DiscountCode,
  DownloadGrant,
  PageQuery,
  Product,
  Reservation,
  StockLevel,
} from "@free-commerce/schema";
import type { AuditRepository, RoleAssignment } from "./access/access";
import type { Outbox } from "./events/events";

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

/** @experimental `ok: false` reasons: unknown id, commit after expiry, or a final state that disagrees. */
export type SettleResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: "not_found" | "expired" | "conflict" };

/** @experimental `reserve` outcome; `conflict`: the id exists but is not a live, identical hold (see `decideReserveRetry`). */
export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: "insufficient" | "conflict" };

/**
 * @experimental Stock and reservations. `reserve` and `settle` MUST each be atomic (all-or-nothing and
 * serialised per variant) so concurrent calls can never oversell or double-consume: in SQL, one
 * transaction that locks the variant's stock row (`SELECT ... FOR UPDATE`, or a conditional `UPDATE`),
 * then checks and writes. Timestamps are canonical UTC ISO strings, so string order is time order;
 * a reservation is expired when `expiresAt <= now`, judged at call time, never by a sweeper.
 */
export interface InventoryRepository {
  getStock(variantId: string): Promise<StockLevel | null>;
  /** Insert or replace the on-hand quantity. */
  setStock(level: StockLevel): Promise<void>;
  /** Units held by `active`, unexpired reservations of the variant. */
  reserved(variantId: string, now: string): Promise<number>;
  /**
   * Atomically insert the reservation as `active` if `onHand - reserved(now) >= quantity`
   * (missing stock is 0), or always when `allowBackorder`. If `id` already exists, nothing is written
   * and core's `decideReserveRetry` decides (retry-safe: only a live, identical hold succeeds).
   */
  reserve(
    reservation: Omit<Reservation, "status">,
    now: string,
    allowBackorder: boolean,
  ): Promise<ReserveResult>;
  /**
   * Atomically apply the transition decided by core's `decideSettle`; on the first transition to
   * `committed` also subtract `quantity` from stock in the same atomic step (never twice).
   */
  settle(
    id: string,
    to: "committed" | "released",
    now: string,
  ): Promise<SettleResult>;
}

/**
 * @experimental Discount codes plus redemption counting. `redeem` MUST be atomic and serialised per
 * code (SQL: advisory lock on the code, then count, check limits, insert) so concurrent orders can
 * never exceed `usageLimit` or `perCustomerLimit`. Redemptions are keyed by `redemptionId` (the order
 * id): redeeming an existing id succeeds without counting twice; `release` deletes it. `save` rejects
 * a `code` already used by another id.
 */
export interface DiscountRepository extends Repository<DiscountCode> {
  /** `code` is upper-case (see `normalizeCode`). */
  getByCode(code: string): Promise<DiscountCode | null>;
  /** Redemptions of the code overall and by `customerKey` (0 when omitted). */
  usage(
    codeId: string,
    customerKey?: string,
  ): Promise<{ total: number; customer: number }>;
  redeem(
    codeId: string,
    redemptionId: string,
    customerKey?: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "not_found" | "usage_limit" | "customer_limit" }
  >;
  release(redemptionId: string): Promise<void>;
}

/** @experimental `ok: false` reasons, in the order they are checked; `not_found` also covers a grant that never existed. */
export type ConsumeResult =
  | { ok: true; grant: DownloadGrant }
  | { ok: false; reason: "not_found" | "revoked" | "expired" | "exhausted" };

/**
 * @experimental Download grants. `consume` MUST be atomic (SQL: one conditional UPDATE): of any number of
 * concurrent calls at most `maxDownloads` succeed, none after `expiresAt <= now` or `revokedAt`. Core's
 * `decideConsume` is the rule; adapters apply it as the update's condition. `find` returns every grant
 * with that value, unordered.
 */
export interface DownloadGrantRepository extends Repository<DownloadGrant> {
  find(by: "orderId" | "accessHash", value: string): Promise<DownloadGrant[]>;
  consume(id: string, now: string): Promise<ConsumeResult>;
}

/** @experimental */
export interface Repositories {
  assets: Repository<DigitalAsset>;
  grants: DownloadGrantRepository;
  roles: Repository<RoleAssignment>;
  audit: AuditRepository;
  discounts: DiscountRepository;
  inventory: InventoryRepository;
  products: ProductRepository;
  carts: CartRepository;
  orders: OrderRepository;
  /** Written in the same transaction as the domain change. */
  outbox: Outbox;
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

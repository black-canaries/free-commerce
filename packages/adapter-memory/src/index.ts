import {
  type Database,
  type DiscountRepository,
  type DomainEvent,
  decideReserveRetry,
  decideSettle,
  type Entity,
  type InventoryRepository,
  type Outbox,
  type Repositories,
  type Repository,
  usageRefusal,
} from "@free-commerce/core";
import type {
  DiscountCode,
  Reservation,
  StockLevel,
} from "@free-commerce/schema";

type State = {
  [K in Exclude<
    keyof Repositories,
    "inventory" | "outbox" | "discounts"
  >]: Repositories[K] extends Repository<infer T> ? Map<string, T> : never;
} & {
  stock: Map<string, StockLevel>;
  reservations: Map<string, Reservation>;
  discounts: Map<string, DiscountCode>;
  redemptions: Map<string, { codeId: string; customerKey?: string }>;
  outbox: Map<string, { event: DomainEvent; delivered: boolean }>;
};

const emptyState = (): State => ({
  products: new Map(),
  carts: new Map(),
  orders: new Map(),
  stock: new Map(),
  reservations: new Map(),
  discounts: new Map(),
  redemptions: new Map(),
  outbox: new Map(),
});

const repository = <T extends Entity>(
  rows: () => Map<string, T>,
): Repository<T> => ({
  async get(id) {
    const row = rows().get(id);
    return row ? structuredClone(row) : null;
  },
  async save(entity) {
    rows().set(entity.id, structuredClone(entity));
  },
  async list({ cursor, limit }) {
    const ids = [...rows().keys()]
      .sort()
      .filter((id) => cursor === undefined || id > cursor);
    const page = ids.slice(0, limit);
    return {
      items: page.map((id) => structuredClone(rows().get(id) as T)),
      nextCursor: ids.length > limit ? (page.at(-1) ?? null) : null,
    };
  },
});

const held = (s: State, variantId: string, now: string) =>
  [...s.reservations.values()]
    .filter(
      (r) =>
        r.variantId === variantId && r.status === "active" && r.expiresAt > now,
    )
    .reduce((sum, r) => sum + r.quantity, 0);

// Each method runs synchronously after its first await-free check, so it is atomic on the JS event loop.
const inventory = (state: () => State): InventoryRepository => ({
  async getStock(variantId) {
    const row = state().stock.get(variantId);
    return row ? { ...row } : null;
  },
  async setStock(level) {
    state().stock.set(level.variantId, { ...level });
  },
  async reserved(variantId, now) {
    return held(state(), variantId, now);
  },
  async reserve(draft, now, allowBackorder) {
    const s = state();
    const existing = s.reservations.get(draft.id);
    if (existing) return decideReserveRetry(existing, draft, now);
    const onHand = s.stock.get(draft.variantId)?.quantity ?? 0;
    if (
      !allowBackorder &&
      onHand - held(s, draft.variantId, now) < draft.quantity
    )
      return { ok: false, reason: "insufficient" };
    const row: Reservation = { ...draft, status: "active" };
    s.reservations.set(row.id, row);
    return { ok: true, reservation: { ...row } };
  },
  async settle(id, to, now) {
    const s = state();
    const before = s.reservations.get(id);
    const out = decideSettle(before, to, now);
    if (out.ok && before && before.status !== to) {
      s.reservations.set(id, out.reservation);
      if (to === "committed")
        s.stock.set(before.variantId, {
          variantId: before.variantId,
          quantity:
            (s.stock.get(before.variantId)?.quantity ?? 0) - before.quantity,
        });
    }
    return out.ok ? { ok: true, reservation: { ...out.reservation } } : out;
  },
});

const discounts = (state: () => State): DiscountRepository => {
  const base = repository(() => state().discounts);
  const counts = (codeId: string, key?: string) => {
    const mine = [...state().redemptions.values()].filter(
      (r) => r.codeId === codeId,
    );
    return {
      total: mine.length,
      customer:
        key === undefined
          ? 0
          : mine.filter((r) => r.customerKey === key).length,
    };
  };
  return {
    ...base,
    async save(code) {
      for (const other of state().discounts.values())
        if (other.code === code.code && other.id !== code.id)
          throw new Error(`discount code ${code.code} already exists`);
      return base.save(code);
    },
    async getByCode(code) {
      const row = [...state().discounts.values()].find((d) => d.code === code);
      return row ? structuredClone(row) : null;
    },
    async usage(codeId, key) {
      return counts(codeId, key);
    },
    // Synchronous after entry, so atomic on the JS event loop.
    async redeem(codeId, redemptionId, customerKey) {
      const s = state();
      const code = s.discounts.get(codeId);
      if (!code) return { ok: false, reason: "not_found" };
      if (s.redemptions.has(redemptionId)) return { ok: true };
      const n = counts(codeId, customerKey);
      const no = usageRefusal(code, n, customerKey);
      if (no) return { ok: false, reason: no };
      s.redemptions.set(redemptionId, { codeId, customerKey });
      return { ok: true };
    },
    async release(redemptionId) {
      state().redemptions.delete(redemptionId);
    },
  };
};

/** Map insertion order is the outbox order. */
const outbox = (rows: () => State["outbox"]): Outbox => ({
  async add(event) {
    if (!rows().has(event.id))
      rows().set(event.id, { event: structuredClone(event), delivered: false });
  },
  async pending(limit) {
    return [...rows().values()]
      .filter((r) => !r.delivered)
      .slice(0, limit)
      .map((r) => structuredClone(r.event));
  },
  async markDelivered(id) {
    const row = rows().get(id);
    if (row) row.delivered = true;
  },
});

const bind = (state: () => State): Repositories => ({
  inventory: inventory(state),
  discounts: discounts(state),
  products: repository(() => state().products),
  carts: repository(() => state().carts),
  orders: repository(() => state().orders),
  outbox: outbox(() => state().outbox),
});

/**
 * @experimental In-memory `Database` for tests and local demos. Transactions run
 * serially on a copy of the state that replaces it only if the callback resolves.
 */
export function createMemoryDatabase(): Database {
  let state = emptyState();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    ...bind(() => state),
    transaction(fn) {
      const run = queue.then(async () => {
        const copy: State = {
          products: new Map(state.products),
          carts: new Map(state.carts),
          orders: new Map(state.orders),
          stock: new Map(state.stock),
          reservations: new Map(state.reservations),
          discounts: new Map(state.discounts),
          redemptions: new Map(state.redemptions),
          outbox: new Map([...state.outbox].map(([k, v]) => [k, { ...v }])),
        };
        const result = await fn(bind(() => copy));
        state = copy;
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

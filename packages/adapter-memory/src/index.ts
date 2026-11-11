import type {
  Database,
  Entity,
  Repositories,
  Repository,
} from "@free-commerce/core";

type State = {
  [K in keyof Repositories]: Repositories[K] extends Repository<infer T>
    ? Map<string, T>
    : never;
};

const emptyState = (): State => ({
  products: new Map(),
  carts: new Map(),
  orders: new Map(),
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

const bind = (state: () => State): Repositories => ({
  products: repository(() => state().products),
  carts: repository(() => state().carts),
  orders: repository(() => state().orders),
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

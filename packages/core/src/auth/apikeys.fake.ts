import type { ApiKey, ApiKeyStore } from "./apikeys";

/** @experimental In-memory `ApiKeyStore` for tests and single-process dev. */
export function createFakeApiKeyStore(): ApiKeyStore {
  const keys = new Map<string, ApiKey>();
  return {
    get: async (id) => keys.get(id) ?? null,
    getByHash: async (hash) =>
      [...keys.values()].find((k) => k.hash === hash) ?? null,
    save: async (key) => {
      if (
        [...keys.values()].some((k) => k.hash === key.hash && k.id !== key.id)
      )
        throw new Error("duplicate key hash");
      keys.set(key.id, key);
    },
    list: async ({ cursor, limit }) => {
      const rows = [...keys.values()]
        .filter((k) => cursor === undefined || k.id > cursor)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit + 1);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
      };
    },
  };
}

import type { ApiKey, ApiKeyStore } from "./apikeys";

/** @experimental In-memory `ApiKeyStore` for tests and single-process dev. */
export function createFakeApiKeyStore(): ApiKeyStore {
  const keys = new Map<string, ApiKey>();
  return {
    get: async (id) => keys.get(id) ?? null,
    getByHash: async (hash) =>
      [...keys.values()].find((k) => k.hash === hash) ?? null,
    save: async (key) => {
      keys.set(key.id, key);
    },
  };
}

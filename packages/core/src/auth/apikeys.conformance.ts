import { describe, expect, it } from "vitest";
import {
  type ApiKeyStore,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
  verifyApiKey,
} from "./apikeys";

/** @experimental Contract every `ApiKeyStore` must pass (fake and Postgres). `make` returns an empty store. */
export function apiKeyStoreConformance(
  name: string,
  make: () => ApiKeyStore | Promise<ApiKeyStore>,
): void {
  describe(`ApiKeyStore conformance: ${name}`, () => {
    const input = {
      type: "secret",
      name: "erp",
      scopes: ["admin:read"],
    } as const;

    it("round-trips by id and by hash, and misses cleanly", async () => {
      const store = await make();
      const { key } = await createApiKey(store, input);
      expect(await store.get(key.id)).toEqual(key);
      expect(await store.getByHash(key.hash)).toEqual(key);
      expect(await store.get("key_missing")).toBeNull();
      expect(await store.getByHash("0".repeat(64))).toBeNull();
    });

    it("refuses a second key with the same hash", async () => {
      const store = await make();
      const { key } = await createApiKey(store, input);
      await expect(store.save({ ...key, id: "key_other" })).rejects.toThrow();
      await store.save({ ...key, name: "renamed" });
      expect((await store.get(key.id))?.name).toBe("renamed");
    });

    it("revocation and rotation take effect on the next verify", async () => {
      const store = await make();
      const a = await createApiKey(store, input);
      const b = await rotateApiKey(store, a.key.id);
      expect(await verifyApiKey(store, a.secret)).toBeNull();
      expect((await verifyApiKey(store, b.secret))?.id).toBe(b.key.id);
      await revokeApiKey(store, b.key.id);
      expect(await verifyApiKey(store, b.secret)).toBeNull();
    });

    it("lists by id with cursor paging", async () => {
      const store = await make();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++)
        ids.push((await createApiKey(store, input, 1000 + i)).key.id);
      ids.sort();
      const p1 = await store.list({ limit: 2 });
      expect(p1.items.map((k) => k.id)).toEqual(ids.slice(0, 2));
      const p2 = await store.list({ limit: 2, cursor: p1.nextCursor ?? "" });
      expect(p2.items.map((k) => k.id)).toEqual(ids.slice(2));
      expect(p2.nextCursor).toBeNull();
    });
  });
}

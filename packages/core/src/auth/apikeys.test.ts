import { describe, expect, it } from "vitest";
import {
  ApiKeyError,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
  verifyApiKey,
} from "./apikeys";
import { createFakeApiKeyStore } from "./apikeys.fake";

const input = { type: "secret", name: "erp", scopes: ["admin:read"] } as const;

describe("api keys", () => {
  it("stores only a hash, never the secret", async () => {
    const store = createFakeApiKeyStore();
    const { key, secret } = await createApiKey(store, input);
    expect(secret).toMatch(/^sk_[0-9a-f]{64}$/);
    expect(JSON.stringify(await store.get(key.id))).not.toContain(secret);
    expect(key.hint).toBe(secret.slice(0, 7));
  });

  it("verifies a secret and rejects unknown ones", async () => {
    const store = createFakeApiKeyStore();
    const { key, secret } = await createApiKey(store, input);
    expect((await verifyApiKey(store, secret))?.id).toBe(key.id);
    expect(await verifyApiKey(store, `${secret}0`)).toBeNull();
    expect(await verifyApiKey(store, "")).toBeNull();
  });

  it("revocation is immediate and idempotent", async () => {
    const store = createFakeApiKeyStore();
    const { key, secret } = await createApiKey(store, input);
    await revokeApiKey(store, key.id);
    await revokeApiKey(store, key.id);
    expect(await verifyApiKey(store, secret)).toBeNull();
    await expect(revokeApiKey(store, "key_missing")).rejects.toThrow(
      ApiKeyError,
    );
  });

  it("expired keys stop working", async () => {
    const store = createFakeApiKeyStore();
    const { secret } = await createApiKey(
      store,
      { ...input, expiresAt: new Date(1000).toISOString() },
      0,
    );
    expect(await verifyApiKey(store, secret, 999)).not.toBeNull();
    expect(await verifyApiKey(store, secret, 1000)).toBeNull();
  });

  it("rotation issues a new key and retires the old after the grace period", async () => {
    const store = createFakeApiKeyStore();
    const old = await createApiKey(store, input, 0);
    const next = await rotateApiKey(store, old.key.id, 5000, 0);
    expect(next.key.scopes).toEqual(["admin:read"]);
    expect(await verifyApiKey(store, old.secret, 4999)).not.toBeNull();
    expect(await verifyApiKey(store, old.secret, 5000)).toBeNull();
    expect(await verifyApiKey(store, next.secret, 5000)).not.toBeNull();
    const instant = await rotateApiKey(store, next.key.id, 0, 10);
    expect(await verifyApiKey(store, next.secret, 10)).toBeNull();
    expect(await verifyApiKey(store, instant.secret, 10)).not.toBeNull();
  });

  it("rotation refuses an expired key", async () => {
    const store = createFakeApiKeyStore();
    const { key } = await createApiKey(
      store,
      { ...input, expiresAt: new Date(1000).toISOString() },
      0,
    );
    await expect(rotateApiKey(store, key.id, 0, 1000)).rejects.toThrow(
      ApiKeyError,
    );
  });

  it("publishable keys cannot hold admin scopes; scopes are required", async () => {
    const store = createFakeApiKeyStore();
    await expect(
      createApiKey(store, { ...input, type: "publishable" }),
    ).rejects.toThrow(ApiKeyError);
    await expect(createApiKey(store, { ...input, scopes: [] })).rejects.toThrow(
      ApiKeyError,
    );
  });
});

import { newId, type PageQuery } from "@free-commerce/schema";
import type { Page } from "../repositories";

/** `read`/`cart` are storefront scopes; `admin:*` open `/admin` routes and only secret keys may hold them. */
export const API_SCOPES = [
  "read",
  "cart",
  "admin:read",
  "admin:write",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export type ApiKeyType = "publishable" | "secret";

/** @experimental Stored form: only the SHA-256 of the secret, never the secret. */
export interface ApiKey {
  id: string;
  type: ApiKeyType;
  name: string;
  scopes: ApiScope[];
  /** First characters of the secret, to recognise a key in a list. Not usable to authenticate. */
  hint: string;
  hash: string;
  createdAt: string;
  /** ISO 8601 or null. Set on the old key by `rotateApiKey` for a grace period. */
  expiresAt: string | null;
  revokedAt: string | null;
}

/**
 * @experimental Persistence for keys. `hash` is unique: `save` of a different id with an existing hash must
 * reject. `list` is ordered by id ascending, same paging as `Repository.list`.
 */
export interface ApiKeyStore {
  get(id: string): Promise<ApiKey | null>;
  getByHash(hash: string): Promise<ApiKey | null>;
  save(key: ApiKey): Promise<void>;
  list(query: PageQuery): Promise<Page<ApiKey>>;
}

export class ApiKeyError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" = "invalid",
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Keys are 256 random bits, so a fast hash is enough (no password-style stretching) and lookup is by hash. */
const hashSecret = async (secret: string): Promise<string> =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    ),
  );

export interface NewApiKey {
  type: ApiKeyType;
  name: string;
  scopes: readonly ApiScope[];
  expiresAt?: string;
}

/** Returns the stored record and the secret, which is shown once and cannot be recovered. */
export const createApiKey = async (
  store: ApiKeyStore,
  input: NewApiKey,
  now: number = Date.now(),
): Promise<{ key: ApiKey; secret: string }> => {
  if (input.scopes.length === 0) throw new ApiKeyError("scopes required");
  if (
    input.type === "publishable" &&
    input.scopes.some((s) => s.startsWith("admin:"))
  )
    throw new ApiKeyError("publishable keys cannot hold admin scopes");
  const random = hex(crypto.getRandomValues(new Uint8Array(32)));
  const secret = `${input.type === "publishable" ? "pk" : "sk"}_${random}`;
  const key: ApiKey = {
    id: newId("key", now),
    type: input.type,
    name: input.name,
    scopes: [...new Set(input.scopes)],
    hint: secret.slice(0, 7),
    hash: await hashSecret(secret),
    createdAt: new Date(now).toISOString(),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
  };
  await store.save(key);
  return { key, secret };
};

/** Resolves the key for a presented secret, or null if unknown, revoked or expired. Checked on every request. */
export const verifyApiKey = async (
  store: ApiKeyStore,
  secret: string,
  now: number = Date.now(),
): Promise<ApiKey | null> => {
  const key = await store.getByHash(await hashSecret(secret));
  if (!key || key.revokedAt) return null;
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return null;
  return key;
};

/** Takes effect on the next request. Idempotent; a missing id is an error. */
export const revokeApiKey = async (
  store: ApiKeyStore,
  id: string,
  now: number = Date.now(),
): Promise<void> => {
  const key = await store.get(id);
  if (!key) throw new ApiKeyError("unknown key", "not_found");
  if (!key.revokedAt)
    await store.save({ ...key, revokedAt: new Date(now).toISOString() });
};

/**
 * Issues a replacement with the same type, name and scopes. The old key stops working after
 * `graceMs` (default: immediately), so a deployment can switch without downtime.
 */
export const rotateApiKey = async (
  store: ApiKeyStore,
  id: string,
  graceMs = 0,
  now: number = Date.now(),
): Promise<{ key: ApiKey; secret: string }> => {
  const old = await store.get(id);
  if (
    !old ||
    old.revokedAt ||
    (old.expiresAt && Date.parse(old.expiresAt) <= now)
  )
    throw new ApiKeyError("unknown, revoked or expired key", "not_found");
  const next = await createApiKey(
    store,
    { type: old.type, name: old.name, scopes: old.scopes },
    now,
  );
  const until = new Date(now + graceMs).toISOString();
  try {
    await store.save({
      ...old,
      expiresAt: old.expiresAt && old.expiresAt < until ? old.expiresAt : until,
    });
  } catch (err) {
    // Fail closed: never leave two live keys because the old one could not be retired.
    await revokeApiKey(store, next.key.id, now);
    throw err;
  }
  return next;
};

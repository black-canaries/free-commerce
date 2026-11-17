import { createMemoryDatabase } from "@free-commerce/adapter-memory";
import type { Role } from "@free-commerce/core";
import {
  type ApiScope,
  createApiKey,
  createDownloads,
  type NewApiKey,
} from "@free-commerce/core";
import {
  createFakeApiKeyStore,
  createFakeAuth,
  createFakeSearch,
  createFakeStorage,
} from "@free-commerce/core/testing";
import {
  type AppDeps,
  createApp,
  type LogEntry,
  memoryIdempotencyStore,
  memoryRateLimitStore,
} from "./index.js";

export const setup = async (over: Partial<AppDeps> = {}) => {
  const logs: LogEntry[] = [];
  const spans: { name: string; attrs: Record<string, unknown> }[] = [];
  const auth = over.auth ?? createFakeAuth();
  const apiKeys = createFakeApiKeyStore();
  const db = createMemoryDatabase();
  const storage = over.storage ?? createFakeStorage();
  const downloads = createDownloads({
    db,
    storage,
    variantOf: async () => null,
  });
  const app = createApp({
    checkDb: async () => {},
    idempotency: memoryIdempotencyStore(),
    rateLimit: memoryRateLimitStore(),
    auth,
    apiKeys,
    db,
    downloads,
    webhookKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    search: createFakeSearch(),
    storage,
    customerOrders: async () => [],
    allowedOrigins: ["https://shop.example"],
    logger: (e) => logs.push(e),
    tracer: {
      startSpan: (name, attrs) => {
        const span = { name, attrs: { ...attrs } };
        spans.push(span);
        return { setAttribute: (k, v) => (span.attrs[k] = v), end() {} };
      },
    },
    ...over,
  });
  const header = async (input: NewApiKey) => ({
    "x-api-key": (await createApiKey(apiKeys, input)).secret,
  });
  const scopes = (...s: ApiScope[]) => s;
  return {
    app,
    logs,
    spans,
    auth,
    apiKeys,
    db,
    downloads,
    storage,
    /** Storefront key and a secret server key with admin scopes, as request headers. */
    pk: await header({
      type: "publishable",
      name: "web",
      scopes: scopes("read", "cart"),
    }),
    sk: await header({
      type: "secret",
      name: "erp",
      scopes: scopes("read", "cart", "admin:read", "admin:write"),
    }),
  };
};

export const post = (
  body: unknown,
  key?: string,
  path = "/store/echo",
  headers: Record<string, string> = {},
) =>
  new Request(`http://x${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(key && { "idempotency-key": key }),
      ...headers,
    },
  });

const creds = { password: "correct horse" };
type T = Awaited<ReturnType<typeof setup>>;

/** A logged-in admin with the given role (`null` = signed up but never assigned one). */
export const as = async (
  t: T,
  role: Role | null,
  email = `${role}@example.com`,
) => {
  await t.auth.signUp("admin", { ...creds, email, name: "Staff Person" });
  const res = await t.app.request("/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ ...creds, email, mode: "bearer" }),
    headers: { "content-type": "application/json" },
  });
  const { userId, token } = (await res.json()) as {
    userId: string;
    token: string;
  };
  if (role) await t.db.roles.save({ id: userId, role });
  return { userId, h: { authorization: `Bearer ${token}` } };
};

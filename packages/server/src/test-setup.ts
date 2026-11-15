import { createMemoryDatabase } from "@free-commerce/adapter-memory";
import {
  type ApiScope,
  createApiKey,
  type NewApiKey,
} from "@free-commerce/core";
import {
  createFakeApiKeyStore,
  createFakeAuth,
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
  const app = createApp({
    checkDb: async () => {},
    idempotency: memoryIdempotencyStore(),
    rateLimit: memoryRateLimitStore(),
    auth,
    apiKeys,
    db,
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

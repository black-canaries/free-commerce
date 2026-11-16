import type { MiddlewareHandler } from "hono";
import { HttpError } from "./errors.js";
import type {
  AppEnv,
  AuthState,
  IdempotencyEntry,
  IdempotencyStore,
  Logger,
  RateLimitStore,
  Tracer,
} from "./types.js";

const SAFE_ID = /^[\w.-]{1,128}$/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Outermost: request ID (inbound `x-request-id` honoured), span, one log line, `x-request-id` on the response. */
export const requestContext =
  (
    logger: Logger,
    tracer: Tracer,
    now: () => number,
  ): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const requestId =
      inbound && SAFE_ID.test(inbound) ? inbound : crypto.randomUUID();
    const { pathname } = new URL(c.req.url);
    const log: Logger = (entry) => logger({ requestId, ...entry });
    c.set("requestId", requestId);
    c.set("log", log);
    const span = tracer.startSpan(`${c.req.method} ${pathname}`, {
      "request.id": requestId,
    });
    const start = now();
    await next();
    c.res.headers.set("x-request-id", requestId);
    const status = c.res.status;
    span.setAttribute("http.status_code", status);
    span.end();
    log({
      level: status >= 500 ? "error" : "info",
      msg: "request",
      method: c.req.method,
      path: pathname,
      status,
      durationMs: now() - start,
    });
  };

/**
 * The client address as seen by the outermost of `trustedProxies` proxies: the entry that many hops from the
 * right of `x-forwarded-for`. Earlier entries are client-supplied and ignored. Without the header: "unknown".
 */
const clientIp = (header: string | undefined, trustedProxies: number) => {
  const hops = header?.split(",").map((h) => h.trim()) ?? [];
  return hops[Math.max(0, hops.length - trustedProxies)] || "unknown";
};

/** Fixed-window limit per client (see `clientIp`; `trustedProxies` must match the deployment). */
export const rateLimit =
  (
    store: RateLimitStore,
    opts: { limit: number; windowMs: number; trustedProxies?: number },
    now: () => number,
    name = "api",
  ): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const client = clientIp(
      c.req.header("x-forwarded-for"),
      opts.trustedProxies ?? 1,
    );
    const { count, resetAt } = await store.hit(
      `${name}:${client}`,
      opts.windowMs,
    );
    if (count > opts.limit) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - now()) / 1000));
      throw new HttpError("rate_limited", "Too many requests", {
        headers: { "retry-after": String(retryAfter) },
      });
    }
    await next();
  };

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

const requireKey = (key: string | undefined): string => {
  if (key && key.length <= 255) return key;
  throw new HttpError(
    "validation_failed",
    "Idempotency-Key header is required (max 255 characters)",
    { details: { header: "idempotency-key" } },
  );
};

const replay = (hit: IdempotencyEntry, fingerprint: string): Response => {
  if (hit.fingerprint !== fingerprint)
    throw new HttpError(
      "idempotency_key_reuse",
      "Idempotency-Key was already used with a different request",
    );
  if (!hit.response)
    throw new HttpError(
      "conflict",
      "A request with this Idempotency-Key is still being processed",
      { headers: { "retry-after": "1" } },
    );
  return new Response(hit.response.body, {
    status: hit.response.status,
    headers: {
      "content-type": hit.response.contentType,
      "idempotent-replayed": "true",
    },
  });
};

/** Keys are private to the caller: a key from one principal can neither replay nor block another's request. */
const principalScope = ({ admin, customer, key }: AuthState): string =>
  customer
    ? `cus:${customer.userId}`
    : admin
      ? `adm:${admin.userId}`
      : key
        ? `key:${key.id}`
        : "anon";

/**
 * Mutating requests must carry `Idempotency-Key`, scoped to the authenticated principal. Same key and same
 * request (method, path, query, body) replays the stored response; same key with anything different is
 * `idempotency_key_reuse`; same key while the first is still running is `conflict` (409, retry shortly).
 * 5xx responses release the key so the client can retry.
 */
export const idempotency =
  (store: IdempotencyStore): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!MUTATING.has(c.req.method)) return next();
    const key = `${principalScope(c.var.auth)}:${requireKey(c.req.header("idempotency-key"))}`;
    const { pathname, search } = new URL(c.req.url);
    const body = await c.req.raw.clone().text();
    const fingerprint = await sha256(
      `${c.req.method} ${pathname}${search}\n${body}`,
    );
    const existing = await store.claim(key, fingerprint);
    if (existing) return replay(existing, fingerprint);
    try {
      await next();
    } catch (err) {
      await store.release(key);
      throw err;
    }
    if (c.res.status >= 500) return store.release(key);
    if (c.var.sensitive)
      return store.complete(key, {
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "conflict",
          message: "This request already succeeded; its secret is shown once",
        }),
      });
    await store.complete(key, {
      status: c.res.status,
      contentType: c.res.headers.get("content-type") ?? "application/json",
      body: await c.res.clone().text(),
    });
  };

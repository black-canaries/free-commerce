import type { MiddlewareHandler } from "hono";
import { HttpError } from "./errors.js";
import type {
  AppEnv,
  IdempotencyStore,
  Logger,
  RateLimitStore,
  StoredResponse,
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

/** Fixed-window limit per client (first `x-forwarded-for` hop: the deploy's proxy must set it). */
export const rateLimit =
  (
    store: RateLimitStore,
    opts: { limit: number; windowMs: number },
    now: () => number,
  ): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const client =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const { count, resetAt } = await store.hit(client, opts.windowMs);
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

const replay = (hit: StoredResponse, fingerprint: string): Response => {
  if (hit.fingerprint !== fingerprint)
    throw new HttpError(
      "idempotency_key_reuse",
      "Idempotency-Key was already used with a different request",
    );
  return new Response(hit.body, {
    status: hit.status,
    headers: {
      "content-type": hit.contentType,
      "idempotent-replayed": "true",
    },
  });
};

/**
 * Mutating requests must carry `Idempotency-Key`. Same key and same request (method, path, query, body)
 * replays the stored response; same key with anything different is `idempotency_key_reuse`.
 * 5xx responses are not stored so the client can retry.
 */
export const idempotency =
  (store: IdempotencyStore): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!MUTATING.has(c.req.method)) return next();
    const key = requireKey(c.req.header("idempotency-key"));
    const { pathname, search } = new URL(c.req.url);
    const body = await c.req.raw.clone().text();
    const fingerprint = await sha256(
      `${c.req.method} ${pathname}${search}\n${body}`,
    );
    const hit = await store.get(key);
    if (hit) return replay(hit, fingerprint);
    await next();
    if (c.res.status < 500)
      await store.set(key, {
        fingerprint,
        status: c.res.status,
        contentType: c.res.headers.get("content-type") ?? "application/json",
        body: await c.res.clone().text(),
      });
  };

import type { ApiKeyStore, AuthProvider } from "@free-commerce/core";
import { type Order, PageQuery } from "@free-commerce/schema";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  type AuthDeps,
  authenticate,
  isAuthRoute,
  mountAuthRoutes,
  requireAdmin,
  requireCustomer,
  requireStoreKey,
} from "./auth.js";
import { errorBody, HttpError, parse } from "./errors.js";
import { consoleLogger, noopTracer } from "./fakes.js";
import { idempotency, rateLimit, requestContext } from "./middleware.js";
import type {
  AppEnv,
  IdempotencyStore,
  Logger,
  RateLimitStore,
  Tracer,
} from "./types.js";

export interface AppDeps {
  /** Resolves when the database answers, rejects otherwise; backs `/ready`. */
  checkDb: () => Promise<void>;
  idempotency: IdempotencyStore;
  rateLimit: RateLimitStore;
  auth: AuthProvider;
  apiKeys: ApiKeyStore;
  /** Orders belonging to a customer (their `cus_` id); this is what keeps customers to their own orders. */
  customerOrders: (customerId: string) => Promise<Order[]>;
  /** Browser origins of storefronts and the admin app (CORS, and CSRF check for cookie-authenticated admin writes). */
  allowedOrigins?: string[];
  cookies?: AuthDeps["cookies"];
  /** Requests per window per client on `/store` and `/admin`. */
  rateLimitOptions?: { limit: number; windowMs: number };
  logger?: Logger;
  tracer?: Tracer;
  now?: () => number;
}

/** Web-standard APIs only, so the same app runs on Node, Bun and edge runtimes. */
export const createApp = (deps: AppDeps) => {
  const now = deps.now ?? Date.now;
  const app = new Hono<AppEnv>();

  const authDeps: AuthDeps = {
    auth: deps.auth,
    apiKeys: deps.apiKeys,
    cookies: deps.cookies,
    allowedOrigins: deps.allowedOrigins ?? [],
    now,
  };

  // Order: context -> CORS -> rate limit -> credentials -> guard -> idempotency -> handler.
  app.use(
    requestContext(
      deps.logger ?? consoleLogger,
      deps.tracer ?? noopTracer,
      now,
    ),
  );
  app.use(
    cors({
      origin: (origin) =>
        authDeps.allowedOrigins.includes(origin) ? origin : null,
      credentials: true,
      allowHeaders: [
        "content-type",
        "authorization",
        "x-api-key",
        "idempotency-key",
        "x-request-id",
      ],
      exposeHeaders: ["x-request-id", "idempotent-replayed", "retry-after"],
    }),
  );
  const limits = rateLimit(
    deps.rateLimit,
    deps.rateLimitOptions ?? { limit: 120, windowMs: 60_000 },
    now,
  );
  // Credential guessing is throttled harder than the API at large; this is the only brute-force defence for logins.
  const authLimits = rateLimit(
    deps.rateLimit,
    { limit: 10, windowMs: 60_000 },
    now,
    "auth",
  );
  const idem = idempotency(deps.idempotency);
  // Login, register and logout are exempt from idempotency: replaying them would store a session token.
  const unlessAuthRoute: MiddlewareHandler<AppEnv> = (c, next) =>
    isAuthRoute(c.req.path) ? next() : idem(c, next);
  app.use("/store/auth/*", authLimits);
  app.use("/admin/auth/*", authLimits);
  app.use(
    "/store/*",
    limits,
    authenticate(authDeps, "customer"),
    requireStoreKey,
    unlessAuthRoute,
  );
  app.use(
    "/admin/*",
    limits,
    authenticate(authDeps, "admin"),
    requireAdmin(authDeps),
    unlessAuthRoute,
  );
  mountAuthRoutes(app, authDeps, "customer");
  mountAuthRoutes(app, authDeps, "admin");

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    try {
      await deps.checkDb();
      return c.json({ status: "ready" });
    } catch (err) {
      c.var.log({
        level: "error",
        msg: "readiness check failed",
        err: String(err),
      });
      return c.json({ status: "unavailable" }, 503);
    }
  });

  const store = app.basePath("/store");
  store.post("/echo", async (c) => {
    const body = parse(
      z.object({ message: z.string().min(1) }),
      await c.req.json().catch(() => undefined),
    );
    return c.json(body);
  });

  store.get("/orders", requireCustomer, async (c) =>
    c.json(await deps.customerOrders(c.var.auth.customer?.userId ?? "")),
  );
  store.get("/orders/:id", requireCustomer, async (c) => {
    const orders = await deps.customerOrders(c.var.auth.customer?.userId ?? "");
    const order = orders.find((o) => o.id === c.req.param("id"));
    if (!order) throw new HttpError("not_found", "Order not found");
    return c.json(order);
  });

  const admin = app.basePath("/admin");
  admin.get("/ping", (c) => c.json(parse(PageQuery, c.req.query())));

  app.notFound((c) => {
    const { requestId } = c.var;
    return c.json(errorBody("not_found", "Route not found", requestId), 404);
  });
  app.onError((err, c) => {
    const { requestId } = c.var;
    if (err instanceof HttpError) {
      const { details, headers } = err.opts;
      return c.json(
        errorBody(err.code, err.message, requestId, details),
        err.status as 400,
        headers,
      );
    }
    c.var.log({
      level: "error",
      msg: "unhandled error",
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json(
      errorBody("internal", "Internal server error", requestId),
      500,
    );
  });

  return app;
};

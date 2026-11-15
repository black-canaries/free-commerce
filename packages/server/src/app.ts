import {
  type ApiKeyStore,
  type AuthProvider,
  type Database,
  type Page,
  type Repository,
  ROLES,
  type RoleAssignment,
} from "@free-commerce/core";
import { type Order, PageQuery } from "@free-commerce/schema";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { audited, authorize, recordChange } from "./access.js";
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
  /** Admin roles and the audit log; `transaction` keeps role changes atomic. */
  db: Pick<Database, "roles" | "audit" | "transaction">;
  /** Orders belonging to a customer (their `cus_` id); this is what keeps customers to their own orders. */
  customerOrders: (customerId: string) => Promise<Order[]>;
  /** Browser origins of storefronts and the admin app (CORS, and CSRF check for cookie-authenticated admin writes). */
  allowedOrigins?: string[];
  cookies?: AuthDeps["cookies"];
  /** Requests per window per client on `/store` and `/admin`. */
  rateLimitOptions?: { limit: number; windowMs: number };
  /** Proxies in front of the app that append to `x-forwarded-for` (default 1). Never trust more than you run. */
  trustedProxies?: number;
  logger?: Logger;
  tracer?: Tracer;
  now?: () => number;
}

/** Pages through the roles until an owner other than `id` turns up. */
const hasOtherOwner = async (
  roles: Repository<RoleAssignment>,
  id: string,
): Promise<boolean> => {
  let cursor: string | undefined;
  do {
    const page: Page<RoleAssignment> = await roles.list({ limit: 100, cursor });
    if (page.items.some((r) => r.role === "owner" && r.id !== id)) return true;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return false;
};

/** Web-standard APIs only, so the same app runs on Node, Bun and edge runtimes. */
export const createApp = (deps: AppDeps) => {
  const now = deps.now ?? Date.now;
  const app = new Hono<AppEnv>();

  const authDeps: AuthDeps = {
    auth: deps.auth,
    apiKeys: deps.apiKeys,
    rateLimit: deps.rateLimit,
    cookies: deps.cookies,
    allowedOrigins: deps.allowedOrigins ?? [],
    now,
  };

  const accessDeps = { db: deps.db, now };

  // Order: context -> CORS -> rate limit -> credentials -> guard -> role -> idempotency -> audit -> handler.
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
    {
      ...(deps.rateLimitOptions ?? { limit: 120, windowMs: 60_000 }),
      trustedProxies: deps.trustedProxies,
    },
    now,
  );
  // Credential guessing is throttled harder than the API at large; this is the only brute-force defence for logins.
  const authLimits = rateLimit(
    deps.rateLimit,
    { limit: 10, windowMs: 60_000, trustedProxies: deps.trustedProxies },
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
    authorize(accessDeps),
    unlessAuthRoute,
    audited(accessDeps),
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

  admin.get("/audit", async (c) => {
    const { actorId, ...page } = parse(
      PageQuery.extend({ actorId: z.string().max(128).optional() }),
      c.req.query(),
    );
    return c.json(await deps.db.audit.list({ ...page, actorId }));
  });

  admin.get("/team", async (c) =>
    c.json(await deps.db.roles.list(parse(PageQuery, c.req.query()))),
  );
  // The whole check-and-write runs in one transaction, so two owners cannot demote each other to zero owners.
  admin.put("/team/:userId", async (c) => {
    const { role } = parse(
      z.object({ role: z.enum(ROLES) }),
      await c.req.json().catch(() => undefined),
    );
    const id = c.req.param("userId");
    const before = await deps.db.transaction(async (tx) => {
      const current = await tx.roles.get(id);
      if (current?.role === "owner" && role !== "owner") {
        if (!(await hasOtherOwner(tx.roles, id)))
          throw new HttpError("conflict", "Cannot remove the last owner");
      }
      await tx.roles.save({ id, role });
      return current?.role;
    });
    recordChange(c, {
      target: `team/${id}`,
      before: { role: before ?? null },
      after: { role },
    });
    return c.json({ id, role });
  });

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

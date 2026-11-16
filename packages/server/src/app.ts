import {
  type ApiKeyStore,
  type AuthProvider,
  type Database,
  type Downloads,
  newAuditEntry,
  type Page,
  type PersonalDataHook,
  type Repository,
  ROLES,
  type RoleAssignment,
  type SearchProvider,
  type StorageProvider,
} from "@free-commerce/core";
import { type Order, PageQuery } from "@free-commerce/schema";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { actorOf, audited, authorize } from "./access.js";
import { mountAdminRoutes } from "./admin.js";
import {
  type AuthDeps,
  authenticate,
  isAuthRoute,
  mountAuthRoutes,
  requireAdmin,
  requireStoreKey,
} from "./auth.js";
import { errorBody, fromDomain, HttpError, parse } from "./errors.js";
import { consoleLogger, noopTracer } from "./fakes.js";
import { idempotency, rateLimit, requestContext } from "./middleware.js";
import { mountStoreRoutes } from "./store.js";
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
  db: Database;
  /** Digital delivery (grants, signed URLs, assets); the checkout and refund services share the same instance. */
  downloads: Downloads;
  search: SearchProvider;
  /** Private object storage for media and digital assets (every read is a signed URL). */
  storage: StorageProvider;
  /**
   * Serves `GET /files/*`: resolves the object a signed URL grants, or null (e.g. `LocalStorage.getSigned`).
   * Leave unset when storage hands out its own URLs (S3/R2).
   */
  serveSigned?: (
    url: string,
  ) => Promise<{ body: Uint8Array; contentType: string } | null>;
  /** Max bytes per upload, enforced while streaming. Defaults: media 5 MB, digital assets 50 MB. */
  uploadLimits?: { media: number; asset: number };
  /** Stores of personal data owned by other modules (e.g. download grants); see `PersonalDataHook`. */
  personalData?: PersonalDataHook[];
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

/** Pages through the roles until an owner other than `id` turns up who still exists as an admin user. */
const hasOtherOwner = async (
  roles: Repository<RoleAssignment>,
  auth: AuthProvider,
  id: string,
): Promise<boolean> => {
  let cursor: string | undefined;
  do {
    const page: Page<RoleAssignment> = await roles.list({ limit: 100, cursor });
    for (const r of page.items)
      if (
        r.role === "owner" &&
        r.id !== id &&
        (await auth.userExists("admin", r.id))
      )
        return true;
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
    customers: deps.db.customers,
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
        "x-download-token",
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
  // Streaming cap, before anything buffers the body (the idempotency fingerprint reads it whole).
  const uploads = deps.uploadLimits ?? { media: 5_000_000, asset: 50_000_000 };
  const sizeLimit: MiddlewareHandler<AppEnv> = (c, next) => {
    const maxSize = /^\/admin\/media\/?$/.test(c.req.path)
      ? uploads.media
      : /^\/admin\/digital-assets(\/[^/]+)?\/?$/.test(c.req.path)
        ? uploads.asset
        : 1_000_000;
    return bodyLimit({
      maxSize,
      onError: (c) =>
        c.json(
          errorBody(
            "validation_failed",
            "Request body too large",
            c.var.requestId,
            { maxBytes: maxSize },
          ),
          413,
        ),
    })(c, next);
  };
  const idem = idempotency(deps.idempotency);
  // Login, register and logout are exempt from idempotency: replaying them would store a session token.
  const unlessAuthRoute: MiddlewareHandler<AppEnv> = (c, next) =>
    isAuthRoute(c.req.path) ? next() : idem(c, next);
  app.use("/store/auth/*", authLimits);
  app.use("/admin/auth/*", authLimits);
  app.use(
    "/store/*",
    limits,
    sizeLimit,
    authenticate(authDeps, "customer"),
    requireStoreKey,
    unlessAuthRoute,
  );
  app.use(
    "/admin/*",
    limits,
    sizeLimit,
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

  mountStoreRoutes(app, deps);
  mountAdminRoutes(app, deps);

  // Signed private files: the signature is the credential. Never inline, never sniffed.
  if (deps.serveSigned) {
    const serve = deps.serveSigned;
    app.get("/files/*", limits, async (c) => {
      const file = await serve(c.req.url);
      if (!file) throw new HttpError("not_found", "File not found");
      return new Response(file.body as Uint8Array<ArrayBuffer>, {
        headers: {
          "content-type": file.contentType,
          "x-content-type-options": "nosniff",
          "content-disposition": "attachment",
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "private, no-store",
        },
      });
    });
  }

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
    if (!(await deps.auth.userExists("admin", id)))
      throw new HttpError("not_found", "No such admin user");
    // Role and audit entry commit together; the middleware then skips its own entry.
    await deps.db.transaction(async (tx) => {
      const before = (await tx.roles.get(id))?.role;
      if (
        before === "owner" &&
        role !== "owner" &&
        !(await hasOtherOwner(tx.roles, deps.auth, id))
      )
        throw new HttpError("conflict", "Cannot remove the last owner");
      await tx.roles.save({ id, role });
      await tx.audit.append(
        newAuditEntry(
          {
            actor: actorOf(c),
            action: `${c.req.method} ${c.req.routePath}`,
            target: `team/${id}`,
            before: { role: before ?? null },
            after: { role },
          },
          now(),
        ),
      );
    });
    c.set("audited", true);
    return c.json({ id, role });
  });

  app.notFound((c) => {
    const { requestId } = c.var;
    return c.json(errorBody("not_found", "Route not found", requestId), 404);
  });
  app.onError((raw, c) => {
    const { requestId } = c.var;
    const err = fromDomain(raw) ?? raw;
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

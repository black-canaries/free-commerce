import { PageQuery } from "@free-commerce/schema";
import { Hono } from "hono";
import { z } from "zod";
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

  // Order: context (id, span, log) -> rate limit -> idempotency -> handler.
  app.use(
    requestContext(
      deps.logger ?? consoleLogger,
      deps.tracer ?? noopTracer,
      now,
    ),
  );
  const limits = rateLimit(
    deps.rateLimit,
    deps.rateLimitOptions ?? { limit: 120, windowMs: 60_000 },
    now,
  );
  for (const group of ["/store/*", "/admin/*"]) {
    app.use(group, limits, idempotency(deps.idempotency));
  }

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

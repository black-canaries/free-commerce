import {
  type Access,
  can,
  type Database,
  newAuditEntry,
  type Role,
} from "@free-commerce/core";
import type { Context, MiddlewareHandler } from "hono";
import { isAuthRoute } from "./auth.js";
import { HttpError } from "./errors.js";
import type { AppEnv } from "./types.js";

export type AccessDeps = {
  db: Pick<Database, "roles" | "audit">;
  now: () => number;
};

const READ = new Set(["GET", "HEAD", "OPTIONS"]);

/** Users get their assigned role (none = no access). Secret keys act as staff with `admin:write`, else read-only; never owner. */
const roleOf = async (
  { db }: AccessDeps,
  c: Context<AppEnv>,
): Promise<Role | undefined> => {
  const { admin, key } = c.var.auth;
  if (admin) return (await db.roles.get(admin.userId))?.role;
  if (key) return key.scopes.includes("admin:write") ? "staff" : "read_only";
};

/** Runs after `requireAdmin`: the central permission table (core `can`) decides; anything unmapped is denied. */
export const authorize =
  (deps: AccessDeps): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (isAuthRoute(c.req.path)) return next();
    const access: Access = READ.has(c.req.method) ? "read" : "write";
    if (!can(await roleOf(deps, c), c.req.path, access))
      throw new HttpError("forbidden", "Your role cannot do this");
    await next();
  };

/** Handlers call this to say what they changed; the entry is redacted and bounded by core `summarize`. */
export const recordChange = (
  c: Context<AppEnv>,
  change: { target: string; before?: unknown; after?: unknown },
): void => c.set("change", change);

/**
 * Every successful admin mutation appends one audit entry (who, what, when, before/after). Replays served
 * by idempotency never reach here, so a retry is not logged twice. If the append fails the request fails
 * loudly (500); handlers whose write must be atomic with its entry append inside their own transaction.
 */
export const audited =
  (deps: AccessDeps): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (READ.has(c.req.method) || isAuthRoute(c.req.path)) return next();
    await next();
    if (c.res.status >= 400) return;
    const { admin, key } = c.var.auth;
    const actor = admin
      ? ({ type: "user", id: admin.userId } as const)
      : ({ type: "key", id: key?.id ?? "unknown" } as const);
    const change = c.var.change;
    await deps.db.audit.append(
      newAuditEntry(
        {
          actor,
          action: `${c.req.method} ${c.req.routePath}`,
          target: change?.target ?? c.req.path,
          before: change?.before,
          after: change?.after,
        },
        deps.now(),
      ),
    );
  };

import {
  type ApiKeyStore,
  type ApiScope,
  type AuthProvider,
  type AuthRealm,
  type AuthSession,
  verifyApiKey,
} from "@free-commerce/core";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { HttpError, parse } from "./errors.js";
import type { AppEnv, AuthState, RateLimitStore } from "./types.js";

export interface AuthDeps {
  auth: AuthProvider;
  apiKeys: ApiKeyStore;
  rateLimit: RateLimitStore;
  /** Cookie attributes; storefronts on another origin need `sameSite: "None"` (requires `secure`). */
  cookies?: { sameSite: "Lax" | "None" | "Strict"; secure: boolean };
  /** Browser origins allowed by CORS and, for cookie-authenticated admin writes, the CSRF check. */
  allowedOrigins: string[];
  now: () => number;
}

const COOKIE = { admin: "fc_admin", customer: "fc_customer" } as const;
const EMAIL_LIMIT = 10;
const EMAIL_WINDOW_MS = 15 * 60_000;
const READ = new Set(["GET", "HEAD", "OPTIONS"]);

const bearer = (c: Context): string | undefined => {
  const h = c.req.header("authorization");
  return h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
};

/** Public auth routes (login, register, logout) take no prior credentials beyond the storefront key. */
export const isAuthRoute = (path: string): boolean =>
  /^\/(store|admin)\/auth\//.test(path);

const resolveKey = async (deps: AuthDeps, c: Context<AppEnv>) => {
  const secret = c.req.header("x-api-key");
  if (!secret) return undefined;
  const key = await verifyApiKey(deps.apiKeys, secret, deps.now());
  if (!key)
    throw new HttpError("unauthenticated", "Invalid or revoked API key");
  return key;
};

/**
 * Resolves credentials into `c.var.auth`; never rejects a request with no credentials (guards do that).
 * `x-api-key` carries a publishable or secret key; sessions come from `Authorization: Bearer` (native) or the
 * realm's cookie (web). A credential that is present but invalid is always `unauthenticated`.
 */
export const authenticate =
  (deps: AuthDeps, realm: AuthRealm): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const state: AuthState = { key: await resolveKey(deps, c) };
    c.set("auth", state);
    const fromHeader = bearer(c);
    const token = fromHeader ?? getCookie(c, COOKIE[realm]);
    const user = token && (await deps.auth.authenticate(realm, token));
    // On login/register/logout a stale credential is as good as none, or it would lock the user out.
    if (token && !user && !isAuthRoute(c.req.path))
      throw new HttpError("unauthenticated", "Invalid or expired session");
    if (user && realm === "admin")
      state.admin = { userId: user.userId, viaCookie: !fromHeader };
    if (user && realm === "customer") state.customer = { userId: user.userId };
    await next();
  };

const scopeFor = (method: string, area: "store" | "admin"): ApiScope =>
  area === "admin"
    ? READ.has(method)
      ? "admin:read"
      : "admin:write"
    : READ.has(method)
      ? "read"
      : "cart";

/** `/store`: every request carries a key whose scope covers the method (`read` for GET, `cart` for writes). */
export const requireStoreKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { key } = c.var.auth;
  if (!key) throw new HttpError("unauthenticated", "API key required");
  if (!key.scopes.includes(scopeFor(c.req.method, "store")))
    throw new HttpError("forbidden", "API key lacks the required scope");
  await next();
};

/** Cookie-authenticated writes need an allowed `Origin`; header tokens and reads are not forgeable cross-site. */
const csrfOk = (c: Context<AppEnv>, deps: AuthDeps, viaCookie: boolean) => {
  const origin = c.req.header("origin");
  return (
    !viaCookie ||
    READ.has(c.req.method) ||
    (!!origin && deps.allowedOrigins.includes(origin))
  );
};

/**
 * `/admin`: an admin session, or a secret key with `admin:read` / `admin:write`. A publishable key or a
 * customer session never passes.
 */
export const requireAdmin =
  (deps: AuthDeps): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (isAuthRoute(c.req.path)) return next();
    const { admin, key } = c.var.auth;
    if (admin) {
      if (!csrfOk(c, deps, admin.viaCookie))
        throw new HttpError("forbidden", "Origin not allowed");
      return next();
    }
    if (!key) throw new HttpError("unauthenticated", "Authentication required");
    const scope = scopeFor(c.req.method, "admin");
    if (key.type !== "secret" || !key.scopes.includes(scope))
      throw new HttpError("forbidden", "API key lacks the required scope");
    await next();
  };

export const requireCustomer: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.auth.customer)
    throw new HttpError("unauthenticated", "Customer login required");
  await next();
};

const Login = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
  /** `cookie` (default) sets an HttpOnly cookie; `bearer` returns the token for native apps. */
  mode: z.enum(["cookie", "bearer"]).default("cookie"),
});
const Register = Login.extend({
  password: z.string().min(8).max(256),
  name: z.string().trim().min(1).max(200),
});

/** Login/register/logout for one realm under `/<prefix>/auth`. Registration exists for customers only. */
export const mountAuthRoutes = (
  app: Hono<AppEnv>,
  deps: AuthDeps,
  realm: AuthRealm,
): void => {
  const base = realm === "admin" ? "/admin/auth" : "/store/auth";
  const cookies = deps.cookies ?? { sameSite: "Lax", secure: true };

  const respond = (
    c: Context<AppEnv>,
    session: AuthSession,
    mode: "cookie" | "bearer",
    status: 200 | 201 = 200,
  ) => {
    const { userId, expiresAt, token } = session;
    if (mode === "bearer") return c.json({ userId, expiresAt, token }, status);
    setCookie(c, COOKIE[realm], token, {
      httpOnly: true,
      path: "/",
      expires: new Date(expiresAt),
      ...cookies,
    });
    return c.json({ userId, expiresAt }, status);
  };

  /** Per-account throttle on top of the per-client one, which a botnet or spoofed headers can sidestep. */
  const throttle = async (email: string) => {
    const { count, resetAt } = await deps.rateLimit.hit(
      `email:${realm}:${email.toLowerCase()}`,
      EMAIL_WINDOW_MS,
    );
    if (count > EMAIL_LIMIT)
      throw new HttpError(
        "rate_limited",
        "Too many attempts for this account",
        {
          headers: {
            "retry-after": String(
              Math.max(1, Math.ceil((resetAt - deps.now()) / 1000)),
            ),
          },
        },
      );
  };

  const login = async (c: Context<AppEnv>, body: z.infer<typeof Login>) => {
    await throttle(body.email);
    const session = await deps.auth.signIn(realm, body);
    if (!session)
      throw new HttpError("unauthenticated", "Invalid email or password");
    return respond(c, session, body.mode);
  };

  app.post(`${base}/login`, async (c) =>
    login(c, parse(Login, await c.req.json().catch(() => undefined))),
  );

  if (realm === "customer")
    app.post(`${base}/register`, async (c) => {
      const body = parse(Register, await c.req.json().catch(() => undefined));
      await throttle(body.email);
      try {
        await deps.auth.signUp(realm, body);
      } catch {
        throw new HttpError("conflict", "Registration failed");
      }
      // A taken email signs up "successfully" at some providers; the sign-in below is what tells them apart.
      const session = await deps.auth.signIn(realm, body);
      if (!session) throw new HttpError("conflict", "Registration failed");
      return respond(c, session, body.mode, 201);
    });

  app.post(`${base}/logout`, async (c) => {
    const token = bearer(c) ?? getCookie(c, COOKIE[realm]);
    if (token) await deps.auth.signOut(realm, token);
    deleteCookie(c, COOKIE[realm], { path: "/", ...cookies });
    return c.json({ ok: true });
  });
};

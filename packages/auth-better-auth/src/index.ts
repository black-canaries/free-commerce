import {
  type AuthProvider,
  type AuthRealm,
  ProviderError,
} from "@free-commerce/core";
import { newId } from "@free-commerce/schema";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";

export interface BetterAuthConfig {
  /** At least 32 characters; signs session tokens. Distinct secrets are derived per realm. */
  secret: string;
  /** A Better Auth database per realm (e.g. `drizzleAdapter(db, ...)`); each realm needs its own tables. Defaults to in-memory. */
  databases?: Partial<
    Record<AuthRealm, Parameters<typeof betterAuth>[0]["database"]>
  >;
  /** Session lifetime in seconds. Default 7 days. */
  sessionSeconds?: number;
}

const ID_PREFIX = { admin: "adm", customer: "cus" } as const;

/**
 * Better Auth behind `AuthProvider` (ADR 0018). Two independent instances (own users, sessions, secret),
 * so an admin token can never authenticate as a customer. Customer user IDs are `cus_...` so they double as
 * the order-ownership key. Tokens travel via Better Auth's bearer plugin; cookies are the server's concern.
 */
export function createBetterAuth(config: BetterAuthConfig): AuthProvider {
  if (config.secret.length < 32)
    throw new RangeError("secret must be at least 32 characters");
  const make = (realm: AuthRealm) =>
    betterAuth({
      secret: `${realm}:${config.secret}`,
      baseURL: "http://localhost", // required by the library; no HTTP handler is mounted
      database:
        config.databases?.[realm] ??
        memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      emailAndPassword: { enabled: true, autoSignIn: false },
      plugins: [bearer()],
      session: { expiresIn: config.sessionSeconds ?? 7 * 24 * 3600 },
      advanced: {
        database: { generateId: () => newId(ID_PREFIX[realm]) },
      },
      rateLimit: { enabled: false }, // the server rate-limits auth routes
      logger: { disabled: true }, // failed logins must not leak into logs
    });
  const instances = { admin: make("admin"), customer: make("customer") };
  const bearerHeaders = (token: string) =>
    new Headers({ authorization: `Bearer ${token}` });

  return {
    async signUp(realm, { email, password, name }) {
      try {
        const { user } = await instances[realm].api.signUpEmail({
          body: { email, password, name },
        });
        return { userId: user.id };
      } catch (cause) {
        throw new ProviderError("better-auth", "rejected", "sign-up refused", {
          cause,
        });
      }
    },
    async signIn(realm, { email, password }) {
      try {
        const res = await instances[realm].api.signInEmail({
          body: { email, password },
          returnHeaders: true,
        });
        const token = res.headers.get("set-auth-token");
        const session = token
          ? await instances[realm].api.getSession({
              headers: bearerHeaders(token),
            })
          : null;
        if (!token || !session) return null;
        return {
          userId: session.user.id,
          token,
          expiresAt: new Date(session.session.expiresAt).toISOString(),
        };
      } catch {
        return null;
      }
    },
    async authenticate(realm, token) {
      if (!token) return null;
      const session = await instances[realm].api
        .getSession({ headers: bearerHeaders(token) })
        .catch(() => null);
      return session ? { userId: session.user.id } : null;
    },
    async userExists(realm, userId) {
      const { internalAdapter } = await instances[realm].$context;
      return (await internalAdapter.findUserById(userId)) !== null;
    },
    async deleteUser(realm, userId) {
      const { internalAdapter } = await instances[realm].$context;
      await internalAdapter.deleteUser(userId); // also removes sessions and accounts
    },
    async signOut(realm, token) {
      await instances[realm].api
        .signOut({ headers: bearerHeaders(token) })
        .catch(() => undefined);
    },
  };
}

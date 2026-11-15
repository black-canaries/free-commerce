/** @experimental Admin and customer identities are separate realms: same email, different accounts, tokens never cross. */
export type AuthRealm = "admin" | "customer";

export interface AuthSession {
  userId: string;
  /** Opaque bearer token; the server sends it as a cookie (web) or in the body (native). */
  token: string;
  /** ISO 8601 UTC. */
  expiresAt: string;
}

/**
 * @experimental Identity and sessions. Adapters map vendor errors to `ProviderError`.
 * Passwords are hashed by the adapter (never hand-rolled here) and never logged.
 */
export interface AuthProvider {
  /**
   * Throws `ProviderError("rejected")` for a password shorter than 8 characters. A taken email may throw the same
   * or resolve with a throwaway id (anti-enumeration); either way the existing account is untouched. Does not sign in.
   */
  signUp(
    realm: AuthRealm,
    input: { email: string; password: string; name: string },
  ): Promise<{ userId: string }>;
  /** Resolves `null` for an unknown email or a wrong password (indistinguishable on purpose). */
  signIn(
    realm: AuthRealm,
    input: { email: string; password: string },
  ): Promise<AuthSession | null>;
  /** Resolves `null` for an unknown, expired, signed-out or other-realm token. */
  authenticate(
    realm: AuthRealm,
    token: string,
  ): Promise<{ userId: string } | null>;
  /** Whether `userId` is a user of that realm (never true across realms). */
  userExists(realm: AuthRealm, userId: string): Promise<boolean>;
  /** Idempotent: an unknown token is a no-op. */
  signOut(realm: AuthRealm, token: string): Promise<void>;
}

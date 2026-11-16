import type { AuthProvider, AuthRealm } from "./auth";
import { ProviderError } from "./error";

const TTL_MS = 60 * 60 * 1000;

/** @experimental In-memory `AuthProvider` for tests. Stores passwords in plain text: never use outside tests. */
export function createFakeAuth(
  now: () => number = () => Date.now(),
): AuthProvider {
  const users = new Map<string, { id: string; password: string }>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const k = (realm: AuthRealm, v: string) => `${realm}:${v}`;
  return {
    async signUp(realm, { email, password }) {
      if (password.length < 8 || users.has(k(realm, email)))
        throw new ProviderError("fake-auth", "rejected", "sign-up refused");
      const id = `usr_${users.size + 1}`;
      users.set(k(realm, email), { id, password });
      return { userId: id };
    },
    async signIn(realm, { email, password }) {
      const user = users.get(k(realm, email));
      if (user?.password !== password) return null;
      const token = crypto.randomUUID();
      const expiresAt = now() + TTL_MS;
      sessions.set(k(realm, token), { userId: user.id, expiresAt });
      return {
        userId: user.id,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
    async authenticate(realm, token) {
      const s = sessions.get(k(realm, token));
      return s && s.expiresAt > now() ? { userId: s.userId } : null;
    },
    async userExists(realm, userId) {
      return [...users.entries()].some(
        ([key, u]) => key.startsWith(`${realm}:`) && u.id === userId,
      );
    },
    async deleteUser(realm, userId) {
      for (const [key, u] of users)
        if (key.startsWith(`${realm}:`) && u.id === userId) users.delete(key);
      for (const [key, s] of sessions)
        if (key.startsWith(`${realm}:`) && s.userId === userId)
          sessions.delete(key);
    },
    async signOut(realm, token) {
      sessions.delete(k(realm, token));
    },
  };
}

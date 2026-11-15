import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "./auth";

const creds = { email: "a@example.com", password: "correct horse" };

/** @experimental Every `AuthProvider` adapter (fake included) must pass this. Sessions must last under 30 days. */
export function authConformance(name: string, make: () => AuthProvider): void {
  describe(`AuthProvider conformance: ${name}`, () => {
    const registered = async () => {
      const auth = make();
      const { userId } = await auth.signUp("customer", { ...creds, name: "A" });
      return { auth, userId };
    };

    it("signs up, signs in and authenticates the token", async () => {
      const { auth, userId } = await registered();
      const session = await auth.signIn("customer", creds);
      expect(session?.userId).toBe(userId);
      expect(await auth.authenticate("customer", session?.token ?? "")).toEqual(
        { userId },
      );
    });

    it("rejects a wrong password and an unknown email the same way", async () => {
      const { auth } = await registered();
      expect(
        await auth.signIn("customer", { ...creds, password: "wrong horse" }),
      ).toBeNull();
      expect(
        await auth.signIn("customer", { ...creds, email: "x@example.com" }),
      ).toBeNull();
    });

    it("rejects short passwords", async () => {
      await expect(
        make().signUp("customer", { ...creds, password: "short", name: "A" }),
      ).rejects.toMatchObject({ code: "rejected" });
    });

    it("a repeated sign-up never changes the existing account", async () => {
      const { auth } = await registered();
      const hijack = { ...creds, password: "attacker pass" };
      await auth.signUp("customer", { ...hijack, name: "X" }).catch(() => {});
      expect(await auth.signIn("customer", hijack)).toBeNull();
      expect(await auth.signIn("customer", creds)).not.toBeNull();
    });

    it("rejects garbage tokens", async () => {
      const { auth } = await registered();
      expect(await auth.authenticate("customer", "nope")).toBeNull();
      expect(await auth.authenticate("customer", "")).toBeNull();
    });

    it("sign-out invalidates the token and is idempotent", async () => {
      const { auth } = await registered();
      const s = await auth.signIn("customer", creds);
      await auth.signOut("customer", s?.token ?? "");
      await auth.signOut("customer", s?.token ?? "");
      expect(await auth.authenticate("customer", s?.token ?? "")).toBeNull();
    });

    it("realms are separate: no cross-realm login or token use", async () => {
      const { auth, userId } = await registered();
      expect(await auth.signIn("admin", creds)).toBeNull();
      const s = await auth.signIn("customer", creds);
      expect(await auth.authenticate("admin", s?.token ?? "")).toBeNull();
      const admin = await auth.signUp("admin", { ...creds, name: "Boss" });
      expect(admin.userId).not.toBe(userId);
    });

    it("knows its own users only, per realm", async () => {
      const { auth, userId } = await registered();
      expect(await auth.userExists("customer", userId)).toBe(true);
      expect(await auth.userExists("admin", userId)).toBe(false);
      expect(await auth.userExists("customer", "nope")).toBe(false);
    });

    it("sessions expire", async () => {
      vi.useFakeTimers();
      try {
        const { auth } = await registered();
        const s = await auth.signIn("customer", creds);
        vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000);
        expect(await auth.authenticate("customer", s?.token ?? "")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
}

import type { AuditEntry, Database } from "@free-commerce/core";
import { describe, expect, it } from "vitest";

const entry = (n: number, actorId = "usr_a"): AuditEntry => ({
  id: `aud_${String(n).padStart(3, "0")}`,
  at: "2026-01-01T00:00:00.000Z",
  actor: { type: "user", id: actorId },
  action: "PUT /admin/team/:userId",
  target: "team/usr_b",
  before: { role: "staff" },
  after: { role: "owner" },
});

/** Audit-log cases, registered inside `repositoryConformance` so every adapter runs them. */
export function auditCases(make: () => Database | Promise<Database>): void {
  describe("audit", () => {
    it("lists newest first with cursor pagination and round-trips entries", async () => {
      const { audit } = await make();
      for (const n of [2, 5, 1, 4, 3]) await audit.append(entry(n));
      const p1 = await audit.list({ limit: 2 });
      expect(p1.items.map((e) => e.id)).toEqual(["aud_005", "aud_004"]);
      expect(p1.items[0]).toEqual(entry(5));
      const p2 = await audit.list({ limit: 2, cursor: p1.nextCursor ?? "" });
      expect(p2.items.map((e) => e.id)).toEqual(["aud_003", "aud_002"]);
      const p3 = await audit.list({ limit: 2, cursor: p2.nextCursor ?? "" });
      expect(p3).toEqual({ items: [entry(1)], nextCursor: null });
    });

    it("filters by actor, ignores a repeated id and never rewrites an entry", async () => {
      const { audit } = await make();
      await audit.append(entry(1, "usr_a"));
      await audit.append(entry(2, "usr_b"));
      await audit.append({ ...entry(1), action: "tampered" });
      const mine = await audit.list({ limit: 10, actorId: "usr_a" });
      expect(mine.items).toEqual([entry(1, "usr_a")]);
    });

    it("keeps entries written in a committed transaction only", async () => {
      const db = await make();
      await db.transaction((tx) => tx.audit.append(entry(1)));
      await expect(
        db.transaction(async (tx) => {
          await tx.audit.append(entry(2));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(
        (await db.audit.list({ limit: 10 })).items.map((e) => e.id),
      ).toEqual(["aud_001"]);
    });
  });
}

import type { Database, WebhookDelivery } from "@free-commerce/core";
import { describe, expect, it } from "vitest";

const delivery = (
  n: number,
  over: Partial<WebhookDelivery> = {},
): WebhookDelivery => ({
  id: `whd_${String(n).padStart(3, "0")}`,
  endpointId: "whk_a",
  event: {
    id: `evt_${n}`,
    type: "order.created",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: { n },
  },
  status: "pending",
  attempts: 0,
  nextAttemptAt: "2026-01-01T00:00:00.000Z",
  lastStatus: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** Webhook delivery cases, registered inside `repositoryConformance` so every adapter runs them. */
export function webhookCases(make: () => Database | Promise<Database>): void {
  describe("webhook deliveries", () => {
    it("create is idempotent: an existing id is never overwritten", async () => {
      const { webhookDeliveries: repo } = await make();
      await repo.create(delivery(1));
      await repo.create(delivery(1, { status: "failed" }));
      expect(await repo.get("whd_001")).toEqual(delivery(1));
    });

    it("due returns only pending deliveries whose time has come, oldest first, up to the limit", async () => {
      const { webhookDeliveries: repo } = await make();
      await repo.create(
        delivery(1, { nextAttemptAt: "2026-01-01T00:10:00.000Z" }),
      );
      await repo.create(
        delivery(2, { nextAttemptAt: "2026-01-01T00:05:00.000Z" }),
      );
      await repo.create(
        delivery(3, { nextAttemptAt: "2026-01-01T02:00:00.000Z" }),
      );
      await repo.create(
        delivery(4, { status: "succeeded", nextAttemptAt: null }),
      );
      await repo.create(delivery(5, { status: "failed", nextAttemptAt: null }));
      const now = "2026-01-01T01:00:00.000Z";
      expect((await repo.due(now, 10)).map((d) => d.id)).toEqual([
        "whd_002",
        "whd_001",
      ]);
      expect((await repo.due(now, 1)).map((d) => d.id)).toEqual(["whd_002"]);
      expect(await repo.due("2025-12-31T00:00:00.000Z", 10)).toEqual([]);
    });

    it("save reschedules a delivery out of the due set", async () => {
      const { webhookDeliveries: repo } = await make();
      await repo.create(delivery(1));
      const now = "2026-01-01T00:00:00.000Z";
      expect(await repo.due(now, 10)).toHaveLength(1);
      await repo.save(
        delivery(1, { attempts: 1, nextAttemptAt: "2026-01-01T00:01:00.000Z" }),
      );
      expect(await repo.due(now, 10)).toEqual([]);
    });

    it("listFor pages one endpoint's deliveries newest first", async () => {
      const { webhookDeliveries: repo } = await make();
      for (const n of [2, 5, 1, 4, 3]) await repo.create(delivery(n));
      await repo.create(delivery(9, { endpointId: "whk_other" }));
      const p1 = await repo.listFor("whk_a", { limit: 2 });
      expect(p1.items.map((d) => d.id)).toEqual(["whd_005", "whd_004"]);
      const p2 = await repo.listFor("whk_a", {
        limit: 2,
        cursor: p1.nextCursor ?? "",
      });
      expect(p2.items.map((d) => d.id)).toEqual(["whd_003", "whd_002"]);
      const p3 = await repo.listFor("whk_a", {
        limit: 2,
        cursor: p2.nextCursor ?? "",
      });
      expect(p3).toEqual({ items: [delivery(1)], nextCursor: null });
    });

    it("rolls back with the transaction", async () => {
      const db = await make();
      await expect(
        db.transaction(async (tx) => {
          await tx.webhookDeliveries.create(delivery(1));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.webhookDeliveries.get("whd_001")).toBeNull();
    });
  });
}

import {
  type Database,
  eraseCustomer,
  exportCustomerData,
  type PersonalDataDeps,
  type PersonalDataHook,
} from "@free-commerce/core";
import { createFakeAuth } from "@free-commerce/core/testing";
import { describe, expect, it } from "vitest";

const NOW = Date.parse("2026-03-01T00:00:00.000Z");
const actor = { type: "user", id: "usr_admin" } as const;
const creds = { email: "ada@example.com", password: "correct horse" };
const PII = [
  "ada@example.com",
  "Ada Lovelace",
  "+4412345",
  "GB123456",
  "12 Crooked Lane",
];

const customer = (id: string, over = {}) => ({
  id,
  kind: "registered" as const,
  email: creds.email,
  name: "Ada Lovelace",
  phone: "+4412345",
  taxId: { type: "eu_vat", value: "GB123456" },
  defaultAddressId: `addr_${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  anonymisedAt: null,
  ...over,
});
const address = (customerId: string) => ({
  id: `addr_${customerId}`,
  customerId,
  name: "Ada Lovelace",
  line1: "12 Crooked Lane",
  city: "London",
  country: "GB",
});
const order = (id: string, customerId?: string) => ({
  id,
  number: 1,
  status: "completed",
  paymentStatus: "paid",
  customerId,
  lines: [
    {
      id: "line_1",
      title: "Mug",
      quantity: 2,
      unitPrice: { amount: 1200, currency: "USD" },
    },
  ],
  total: { amount: 2400, currency: "USD" },
  refunds: ["fingerprint"],
});

/** Personal-data cases, registered inside `repositoryConformance` so every adapter runs them. */
export function privacyCases(make: () => Database | Promise<Database>): void {
  describe("personal data", () => {
    const world = async (hooks: PersonalDataHook[] = []) => {
      const db = await make();
      const auth = createFakeAuth();
      const { userId } = await auth.signUp("customer", {
        ...creds,
        name: "Ada",
      });
      const mine = userId;
      await db.customers.save(customer(mine));
      await db.customers.save(
        customer("cus_other", { email: "bob@example.com", name: "Bob" }),
      );
      for (const id of [mine, "cus_other"])
        await db.addresses.save(address(id));
      await db.orders.save(order("ord_mine", mine));
      await db.orders.save(order("ord_other", "cus_other"));
      await db.orders.save(order("ord_guest"));
      const deps: PersonalDataDeps = { db, auth, hooks, now: () => NOW };
      return { db, auth, deps, mine };
    };

    it("finds addresses and orders by owner only; deleting addresses is scoped and idempotent", async () => {
      const { db, mine } = await world();
      expect((await db.orders.listByCustomer(mine)).map((o) => o.id)).toEqual([
        "ord_mine",
      ]);
      expect(
        (await db.addresses.listByCustomer(mine)).map((a) => a.id),
      ).toEqual([`addr_${mine}`]);
      await db.addresses.deleteByCustomer(mine);
      await db.addresses.deleteByCustomer(mine);
      expect(await db.addresses.listByCustomer(mine)).toEqual([]);
      expect(await db.addresses.listByCustomer("cus_other")).toHaveLength(1);
    });

    it("exports only the requesting customer's data, without secrets", async () => {
      const { deps, mine } = await world();
      const out = await exportCustomerData(deps, mine, actor);
      const text = JSON.stringify(out);
      expect(out.customer.id).toBe(mine);
      expect(out.orders.map((o) => o.id)).toEqual(["ord_mine"]);
      expect(out.addresses).toHaveLength(1);
      expect(text).not.toMatch(
        /bob|cus_other|ord_other|ord_guest|fingerprint|password|token/i,
      );
      expect((await deps.db.audit.list({ limit: 5 })).items[0]).toMatchObject({
        action: "privacy.export",
        target: `customers/${mine}`,
      });
    });

    it("an unknown customer is refused and writes no audit entry", async () => {
      const { deps } = await world();
      await expect(
        exportCustomerData(deps, "cus_nope", actor),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        eraseCustomer(deps, "cus_nope", actor),
      ).rejects.toMatchObject({ code: "not_found" });
      expect((await deps.db.audit.list({ limit: 5 })).items).toEqual([]);
    });

    it("erasure leaves no personal data, keeps order totals, and is idempotent", async () => {
      const { deps, db, auth, mine } = await world();
      expect(await eraseCustomer(deps, mine, actor)).toEqual({ erased: true });
      expect(await eraseCustomer(deps, mine, actor)).toEqual({ erased: false });
      const left = await db.customers.get(mine);
      expect(left).toMatchObject({
        email: null,
        name: null,
        phone: null,
        taxId: null,
        defaultAddressId: null,
        anonymisedAt: "2026-03-01T00:00:00.000Z",
      });
      expect(await db.addresses.listByCustomer(mine)).toEqual([]);
      const kept = await db.orders.get("ord_mine");
      expect(kept).toMatchObject({
        total: { amount: 2400, currency: "USD" },
        lines: [{ title: "Mug", quantity: 2 }],
      });
      expect(kept).not.toHaveProperty("customerId");
      expect(await auth.signIn("customer", creds)).toBeNull();
      const dump = JSON.stringify([
        await db.customers.get(mine),
        (await db.audit.list({ limit: 50 })).items,
        await db.outbox.pending(50),
        await db.orders.get("ord_mine"),
      ]);
      for (const secret of PII) expect(dump).not.toContain(secret);
      expect(
        (await db.audit.list({ limit: 50 })).items.map((e) => e.action),
      ).toEqual(["privacy.erase"]);
      expect(await db.outbox.pending(50)).toHaveLength(1);
      expect(await db.customers.get("cus_other")).toMatchObject({
        name: "Bob",
      });
      expect(await db.orders.get("ord_other")).toHaveProperty(
        "customerId",
        "cus_other",
      );
    });

    it("a failing hook rolls everything back; the retry finishes the job", async () => {
      let broken = true;
      const erased: string[] = [];
      const hook: PersonalDataHook = {
        name: "grants",
        export: async () => ["grant"],
        erase: async (id) => {
          if (broken) throw new Error("boom");
          erased.push(id);
        },
      };
      const { deps, db, auth, mine } = await world([hook]);
      await expect(eraseCustomer(deps, mine, actor)).rejects.toThrow("boom");
      expect(await db.customers.get(mine)).toMatchObject({
        email: creds.email,
      });
      expect(await db.addresses.listByCustomer(mine)).toHaveLength(1);
      expect(await db.orders.get("ord_mine")).toHaveProperty(
        "customerId",
        mine,
      );
      expect(await db.outbox.pending(5)).toEqual([]);
      expect(await auth.signIn("customer", creds)).not.toBeNull(); // not locked out: they can retry
      broken = false;
      expect(await eraseCustomer(deps, mine, actor)).toEqual({ erased: true });
      expect(erased).toEqual([mine]);
      expect(
        (await exportCustomerData(deps, mine, actor)).extra.grants,
      ).toEqual(["grant"]);
    });
  });
}

import type { Role } from "@free-commerce/core";
import { ADMIN_GROUPS, can } from "@free-commerce/core";
import { describe, expect, it } from "vitest";
import { post, setup } from "./test-setup.js";

const creds = { password: "correct horse" };
type T = Awaited<ReturnType<typeof setup>>;

/** A logged-in admin with the given role (`null` = signed up but never assigned one). */
const as = async (t: T, role: Role | null, email = `${role}@example.com`) => {
  await t.auth.signUp("admin", { ...creds, email, name: "Staff Person" });
  const res = await t.app.request("/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ ...creds, email, mode: "bearer" }),
    headers: { "content-type": "application/json" },
  });
  const { userId, token } = (await res.json()) as {
    userId: string;
    token: string;
  };
  if (role) await t.db.roles.save({ id: userId, role });
  return { userId, h: { authorization: `Bearer ${token}` } };
};

// Segments that have a stub handler here; every one of them is in ADMIN_GROUPS.
const SEGMENTS = Object.keys(ADMIN_GROUPS);
const stubbed = async () => {
  const t = await setup();
  for (const s of SEGMENTS) {
    t.app.get(`/admin/${s}/x`, (c) => c.json({ ok: true }));
    t.app.post(`/admin/${s}/x`, (c) => c.json({ ok: true }));
  }
  return t;
};

/** Expected outcome per role, derived by hand (not from `can`) so the table itself is under test. */
const EXPECT: Record<Role, { read: string[]; write: string[] }> = {
  owner: { read: SEGMENTS, write: SEGMENTS },
  staff: {
    read: [
      "ping",
      "products",
      "collections",
      "media",
      "inventory",
      "orders",
      "customers",
      "discounts",
      "shipping",
      "tax",
      "settings",
    ],
    write: [
      "ping",
      "products",
      "collections",
      "media",
      "inventory",
      "orders",
      "customers",
      "discounts",
    ],
  },
  read_only: {
    read: [
      "ping",
      "products",
      "collections",
      "media",
      "inventory",
      "orders",
      "customers",
      "discounts",
      "shipping",
      "tax",
      "settings",
    ],
    write: [],
  },
};

describe("roles x route groups", () => {
  for (const role of ["owner", "staff", "read_only"] as const)
    it(`${role}: allowed exactly what the table grants`, async () => {
      const t = await stubbed();
      const { h } = await as(t, role);
      for (const s of SEGMENTS) {
        const get = await t.app.request(`/admin/${s}/x`, { headers: h });
        expect(get.status === 200, `${role} GET ${s}`).toBe(
          EXPECT[role].read.includes(s),
        );
        const w = await t.app.fetch(
          post({}, `k-${role}-${s}`, `/admin/${s}/x`, h),
        );
        expect(w.status === 200, `${role} POST ${s}`).toBe(
          EXPECT[role].write.includes(s),
        );
        if (w.status !== 200) expect(w.status).toBe(403);
      }
    });

  it("a user with no role assigned is denied everywhere", async () => {
    const t = await stubbed();
    const { h } = await as(t, null);
    for (const s of SEGMENTS)
      expect(
        (await t.app.request(`/admin/${s}/x`, { headers: h })).status,
      ).toBe(403);
  });

  it("a route group added without a permission entry fails closed, even for owners", async () => {
    const t = await setup();
    t.app.get("/admin/brand-new/x", (c) => c.json({ ok: true }));
    t.app.post("/admin/brand-new/x", (c) => c.json({ ok: true }));
    const { h } = await as(t, "owner");
    expect(
      (await t.app.request("/admin/brand-new/x", { headers: h })).status,
    ).toBe(403);
    expect(
      (await t.app.fetch(post({}, "k", "/admin/brand-new/x", h))).status,
    ).toBe(403);
    expect(can("owner", "/admin/brand-new/x", "read")).toBe(false);
    expect(can("owner", "/admin", "read")).toBe(false);
    expect(can("owner", "/admin/__proto__/x", "read")).toBe(false);
  });

  it("secret keys act as staff (write) or read-only, never owner", async () => {
    const t = await stubbed();
    const ok = async (path: string, method = "GET") =>
      (
        await t.app.fetch(
          method === "GET"
            ? new Request(`http://x${path}`, { headers: t.sk })
            : post({}, `k${path}`, path, t.sk),
        )
      ).status;
    expect(await ok("/admin/products/x")).toBe(200);
    expect(await ok("/admin/products/x", "POST")).toBe(200);
    expect(await ok("/admin/api-keys/x")).toBe(403);
    expect(await ok("/admin/team/x", "POST")).toBe(403);
    expect(await ok("/admin/audit")).toBe(403);
  });
});

describe("team", () => {
  it("owners assign roles; staff cannot; the last owner cannot be removed", async () => {
    const t = await setup();
    const owner = await as(t, "owner");
    const staff = await as(t, "staff");
    const asPut = (who: typeof owner, id: string, role: string, k: string) =>
      t.app.fetch(
        new Request(`http://x/admin/team/${id}`, {
          method: "PUT",
          body: JSON.stringify({ role }),
          headers: {
            ...who.h,
            "content-type": "application/json",
            "idempotency-key": k,
          },
        }),
      );
    expect((await asPut(staff, staff.userId, "owner", "a")).status).toBe(403);
    expect((await asPut(owner, staff.userId, "read_only", "b")).status).toBe(
      200,
    );
    expect((await t.db.roles.get(staff.userId))?.role).toBe("read_only");
    expect((await asPut(owner, owner.userId, "staff", "c")).status).toBe(409);
    expect((await t.db.roles.get(owner.userId))?.role).toBe("owner");
    expect((await asPut(owner, staff.userId, "root", "d")).status).toBe(400);
    expect((await asPut(owner, staff.userId, "owner", "e")).status).toBe(200);
    expect((await asPut(owner, owner.userId, "staff", "f")).status).toBe(200);
  });
});

describe("audit log", () => {
  it("every successful admin mutation is recorded, with redacted before/after", async () => {
    const t = await setup();
    const owner = await as(t, "owner");
    const staff = await as(t, "staff");
    const res = await t.app.fetch(
      new Request(`http://x/admin/team/${staff.userId}`, {
        method: "PUT",
        body: JSON.stringify({ role: "read_only" }),
        headers: {
          ...owner.h,
          "content-type": "application/json",
          "idempotency-key": "k1",
        },
      }),
    );
    expect(res.status).toBe(200);
    const log = await t.app.request("/admin/audit", { headers: owner.h });
    const { items } = (await log.json()) as {
      items: Record<string, unknown>[];
    };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      actor: { type: "user", id: owner.userId },
      action: "PUT /admin/team/:userId",
      target: `team/${staff.userId}`,
      before: { role: "staff" },
      after: { role: "read_only" },
    });
    expect(items[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("a mutation without handler detail still leaves who/what; failures and reads leave nothing", async () => {
    const t = await setup();
    t.app.post("/admin/orders/:id/note", (c) => c.json({ ok: true }));
    t.app.post("/admin/orders/boom", () => {
      throw new Error("x");
    });
    const owner = await as(t, "owner");
    await t.app.fetch(
      post(
        { note: "hi", email: "a@b.c" },
        "n1",
        "/admin/orders/o1/note",
        owner.h,
      ),
    );
    await t.app.fetch(post({}, "n2", "/admin/orders/boom", owner.h));
    await t.app.request("/admin/ping", { headers: owner.h });
    const staff = await as(t, "read_only");
    await t.app.fetch(post({}, "n3", "/admin/orders/o1/note", staff.h)); // 403
    const { items } = await t.db.audit.list({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: "POST /admin/orders/:id/note",
      actor: { id: owner.userId },
    });
  });

  it("an idempotent replay is not logged twice; key actors are recorded", async () => {
    const t = await setup();
    t.app.post("/admin/orders/x", (c) => c.json({ ok: true }));
    const r = () => t.app.fetch(post({}, "same", "/admin/orders/x", t.sk));
    await r();
    expect((await r()).headers.get("idempotent-replayed")).toBe("true");
    const { items } = await t.db.audit.list({ limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]?.actor.type).toBe("key");
  });

  it("only owners can query it; filter by actor and paginate", async () => {
    const t = await setup();
    t.app.post("/admin/orders/x", (c) => c.json({ ok: true }));
    const owner = await as(t, "owner");
    const staff = await as(t, "staff");
    for (const [n, who] of [
      ["a", owner],
      ["b", staff],
      ["c", staff],
    ] as const)
      await t.app.fetch(post({}, n, "/admin/orders/x", who.h));
    expect(
      (await t.app.request("/admin/audit", { headers: staff.h })).status,
    ).toBe(403);
    const q = async (qs: string) =>
      (await (
        await t.app.request(`/admin/audit?${qs}`, { headers: owner.h })
      ).json()) as {
        items: { actor: { id: string } }[];
        nextCursor: string | null;
      };
    expect((await q(`actorId=${staff.userId}`)).items).toHaveLength(2);
    const p1 = await q("limit=2");
    expect(p1.items).toHaveLength(2);
    expect((await q(`limit=2&cursor=${p1.nextCursor}`)).items).toHaveLength(1);
  });
});

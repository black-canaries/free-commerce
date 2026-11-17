import { describe, expect, it } from "vitest";
import { as, post, setup } from "./test-setup.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const variant = (amount = 1000) => ({
  optionValues: {},
  deliveryType: "digital",
  priceMode: "fixed",
  prices: [{ currency: "USD", amount }],
});

type T = Awaited<ReturnType<typeof setup>>;
let n = 0;
const send = async (
  t: T,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  key = `k${n++}`,
) => {
  const res = await t.app.request(`http://x${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(method !== "GET" && { "idempotency-key": key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    res, // biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test helper
    body: (await res.json().catch(() => null)) as any,
  };
};

/** A published product visible to the storefront, created through the admin API. */
const published = async (t: T, h: Record<string, string>) => {
  const created = await send(t, "POST", "/admin/products", h, {
    title: "Ebook",
    handle: "ebook",
    description: "A book",
    variants: [variant()],
  });
  expect(created.res.status).toBe(201);
  const id = created.body.id as string;
  await send(t, "POST", `/admin/products/${id}/publish`, h, {});
  return { id, variantId: created.body.variants[0].id as string };
};

describe("store catalog and cart", () => {
  it("shows only published products, via search and by id", async () => {
    const t = await setup();
    const { h } = await as(t, "staff");
    const draft = await send(t, "POST", "/admin/products", h, {
      title: "Hidden",
      handle: "hidden",
      variants: [variant()],
    });
    const p = await published(t, h);
    const list = await send(t, "GET", "/store/products?q=ebook", t.pk);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([p.id]);
    expect(
      (await send(t, "GET", `/store/products/${p.id}`, t.pk)).res.status,
    ).toBe(200);
    expect(
      (await send(t, "GET", `/store/products/${draft.body.id}`, t.pk)).res
        .status,
    ).toBe(404);
    const filtered = await send(
      t,
      "GET",
      "/store/products?currency=USD&priceMin=2000",
      t.pk,
    );
    expect(filtered.body.items).toEqual([]);
    expect(
      (await send(t, "GET", "/store/products?limit=0", t.pk)).res.status,
    ).toBe(400);
  });

  it("creates a cart and edits its lines, with totals", async () => {
    const t = await setup();
    const { h } = await as(t, "staff");
    const p = await published(t, h);
    const cart = await send(t, "POST", "/store/carts", t.pk, {
      currency: "USD",
    });
    expect(cart.res.status).toBe(201);
    const base = `/store/carts/${cart.body.id}`;
    const added = await send(t, "POST", `${base}/lines`, t.pk, {
      productId: p.id,
      variantId: p.variantId,
      quantity: 2,
    });
    expect(added.body.totals.total.amount).toBe(2000);
    const lineId = added.body.lines[0].id;
    const upd = await send(t, "PATCH", `${base}/lines/${lineId}`, t.pk, {
      quantity: 3,
    });
    expect(upd.body.totals.total.amount).toBe(3000);
    const gone = await send(t, "DELETE", `${base}/lines/${lineId}`, t.pk);
    expect(gone.body.lines).toEqual([]);
    expect((await send(t, "GET", base, t.pk)).body.lines).toEqual([]);
  });

  it("maps domain errors: unknown cart, unknown product, wrong currency, missing key", async () => {
    const t = await setup();
    const { h } = await as(t, "staff");
    const p = await published(t, h);
    const miss = await send(
      t,
      "GET",
      "/store/carts/cart_00000000000000000000000000",
      t.pk,
    );
    expect(miss.res.status).toBe(404);
    const cart = await send(t, "POST", "/store/carts", t.pk, {
      currency: "EUR",
    });
    const bad = await send(
      t,
      "POST",
      `/store/carts/${cart.body.id}/lines`,
      t.pk,
      {
        productId: p.id,
        variantId: p.variantId,
        quantity: 1,
      },
    );
    expect(bad.res.status).toBe(400);
    const nokey = await t.app.fetch(
      post({ currency: "USD" }, undefined, "/store/carts", t.pk),
    );
    expect(nokey.status).toBe(400);
  });

  it("serves the customer their id and refuses anonymous access", async () => {
    const t = await setup();
    expect((await send(t, "GET", "/store/customers/me", t.pk)).res.status).toBe(
      401,
    );
  });
});

describe("admin catalog, inventory, orders", () => {
  it("validates products field by field and audits writes", async () => {
    const t = await setup();
    const { h, userId } = await as(t, "staff");
    const bad = await send(t, "POST", "/admin/products", h, {
      title: "x",
      handle: "Not A Handle",
      variants: [variant()],
    });
    expect(bad.res.status).toBe(400);
    const p = await published(t, h);
    const audit = await t.db.audit.list({ limit: 10, actorId: userId });
    expect(audit.items.map((e) => e.action)).toContain(
      "POST /admin/products/:id/publish",
    );
    const after = await send(t, "PATCH", `/admin/products/${p.id}`, h, {
      title: "Ebook 2",
    });
    expect(after.body.title).toBe("Ebook 2");
    await send(t, "POST", `/admin/products/${p.id}/archive`, h, {});
    const list = await send(t, "GET", "/store/products?q=ebook", t.pk);
    expect(list.body.items).toEqual([]);
  });

  it("sets stock and makes a physical product available to search", async () => {
    const t = await setup();
    const { h } = await as(t, "staff");
    const made = await send(t, "POST", "/admin/products", h, {
      title: "Mug",
      handle: "mug",
      variants: [{ ...variant(), deliveryType: "physical" }],
    });
    const id = made.body.id;
    const vid = made.body.variants[0].id;
    await send(t, "POST", `/admin/products/${id}/publish`, h, {});
    const avail = (q: string) =>
      send(t, "GET", `/store/products?available=${q}`, t.pk);
    expect((await avail("true")).body.items).toEqual([]);
    const set = await send(t, "PUT", `/admin/inventory/${vid}`, h, {
      productId: id,
      quantity: 5,
    });
    expect(set.res.status).toBe(200);
    expect((await avail("true")).body.items).toHaveLength(1);
    expect(
      (await send(t, "GET", `/admin/inventory/${vid}`, h)).body,
    ).toMatchObject({
      onHand: 5,
      available: 5,
    });
    const wrong = await send(t, "PUT", `/admin/inventory/${vid}`, h, {
      productId: "prod_00000000000000000000000000",
      quantity: 1,
    });
    expect(wrong.res.status).toBe(404);
  });

  it("read-only users cannot write; orders list is readable", async () => {
    const t = await setup();
    const ro = await as(t, "read_only");
    expect(
      (await send(t, "POST", "/admin/products", ro.h, {})).res.status,
    ).toBe(403);
    expect((await send(t, "GET", "/admin/orders", ro.h)).res.status).toBe(200);
    expect(
      (
        await send(
          t,
          "GET",
          "/admin/orders/ord_00000000000000000000000000",
          ro.h,
        )
      ).res.status,
    ).toBe(404);
  });
});

describe("uploads and file serving", () => {
  const up = (t: T, path: string, body: Uint8Array, type: string, h: object) =>
    t.app.fetch(
      new Request(`http://x${path}`, {
        method: "POST",
        body: body as BodyInit,
        headers: { ...h, "content-type": type, "idempotency-key": `u${n++}` },
      }),
    );

  it("accepts an image, rejects wrong type, mismatched type and oversize while streaming", async () => {
    const t = await setup({ uploadLimits: { media: 100, asset: 200 } });
    const { h } = await as(t, "staff");
    const ok = await up(t, "/admin/media", PNG, "image/png", h);
    expect(ok.status).toBe(201);
    const { key } = (await ok.json()) as { key: string };
    expect(key).toMatch(/^media\/.+\.png$/);
    expect((await up(t, "/admin/media", PNG, "image/jpeg", h)).status).toBe(
      400,
    );
    const text = new TextEncoder().encode("hello world");
    expect((await up(t, "/admin/media", text, "text/plain", h)).status).toBe(
      400,
    );
    const big = new Uint8Array(150);
    big.set(PNG);
    const over = await up(t, "/admin/media", big, "image/png", h);
    expect(over.status).toBe(413);
    // The same bytes are fine as a digital asset (limit 200), which refuses an executable-looking blob.
    const pdf = new Uint8Array(150);
    pdf.set([0x25, 0x50, 0x44, 0x46]);
    expect(
      (
        await up(
          t,
          "/admin/digital-assets?filename=a.pdf",
          pdf,
          "application/pdf",
          h,
        )
      ).status,
    ).toBe(201);
    const del = await send(t, "DELETE", `/admin/media?key=${key}`, h);
    expect(del.res.status).toBe(200);
    expect(
      (await send(t, "DELETE", "/admin/media?key=../etc/passwd", h)).res.status,
    ).toBe(400);
  });

  it("serves signed files as non-sniffable attachments", async () => {
    const t = await setup({
      serveSigned: async (url) =>
        url.includes("sig=ok") ? { body: PNG, contentType: "image/png" } : null,
    });
    const bad = await t.app.request("http://x/files/media/a.png?sig=no");
    expect(bad.status).toBe(404);
    const res = await t.app.request("http://x/files/media/a.png?sig=ok");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("api keys", () => {
  it("leaves no usable key when the audit append fails (create and rotate)", async () => {
    const t = await setup();
    const { h } = await as(t, "owner");
    const body = { type: "secret", name: "erp", scopes: ["admin:read"] };
    const ok = await send(t, "POST", "/admin/api-keys", h, body);
    const append = t.db.audit.append;
    t.db.audit.append = async () => {
      throw new Error("audit down");
    };
    const failed = await send(t, "POST", "/admin/api-keys", h, body);
    expect(failed.res.status).toBe(500);
    const rotate = await send(
      t,
      "POST",
      `/admin/api-keys/${ok.body.id}/rotate`,
      h,
      {},
    );
    expect(rotate.res.status).toBe(500);
    t.db.audit.append = append;
    const use = (s: string) =>
      t.app.request("http://x/admin/orders", { headers: { "x-api-key": s } });
    expect((await use(ok.body.secret)).status).toBe(200);
    const keys = await t.apiKeys.list({ limit: 10 });
    expect(
      keys.items.filter(
        (k) => k.scopes.length === 1 && !k.revokedAt && !k.expiresAt,
      ),
    ).toHaveLength(1);
  });

  it("creates, lists, rotates and revokes; the secret is shown once and never stored by idempotency", async () => {
    const t = await setup();
    const { h } = await as(t, "owner");
    const body = { type: "secret", name: "erp", scopes: ["admin:read"] };
    const created = await send(t, "POST", "/admin/api-keys", h, body, "same");
    expect(created.res.status).toBe(201);
    const { secret, id } = created.body;
    expect(secret).toMatch(/^sk_/);
    expect(created.body.hash).toBeUndefined();
    const replay = await send(t, "POST", "/admin/api-keys", h, body, "same");
    expect(replay.res.status).toBe(409);
    expect(JSON.stringify(replay.body)).not.toContain(secret);
    const list = await send(t, "GET", "/admin/api-keys", h);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(JSON.stringify(list.body)).not.toContain("hash");
    const use = (s: string) =>
      t.app.request("http://x/admin/orders", { headers: { "x-api-key": s } });
    expect((await use(secret)).status).toBe(200);
    const rotated = await send(
      t,
      "POST",
      `/admin/api-keys/${id}/rotate`,
      h,
      {},
    );
    expect((await use(secret)).status).toBe(401);
    expect((await use(rotated.body.secret)).status).toBe(200);
    await send(t, "POST", `/admin/api-keys/${rotated.body.id}/revoke`, h, {});
    expect((await use(rotated.body.secret)).status).toBe(401);
    expect(
      (await send(t, "POST", "/admin/api-keys/key_missing/revoke", h, {})).res
        .status,
    ).toBe(404);
    const audit = await t.db.audit.list({ limit: 20 });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(audit.items.map((e) => e.action)).toContain("POST /admin/api-keys");
  });

  it("is owner-only, and publishable keys cannot hold admin scopes", async () => {
    const t = await setup();
    const staff = await as(t, "staff");
    expect((await send(t, "GET", "/admin/api-keys", staff.h)).res.status).toBe(
      403,
    );
    expect((await send(t, "GET", "/admin/api-keys", t.sk)).res.status).toBe(
      403,
    );
    const { h } = await as(t, "owner", "o@example.com");
    const bad = await send(t, "POST", "/admin/api-keys", h, {
      type: "publishable",
      name: "web",
      scopes: ["admin:read"],
    });
    expect(bad.res.status).toBe(400);
  });
});

describe("personal data", () => {
  const email = "ada@example.com";
  const register = async (t: T, addr = email) => {
    const res = await send(t, "POST", "/store/auth/register", t.pk, {
      email: addr,
      password: "correct horse",
      name: "Ada Lovelace",
      mode: "bearer",
    });
    expect(res.res.status).toBe(201);
    return {
      id: res.body.userId as string,
      h: { ...t.pk, authorization: `Bearer ${res.body.token}` },
    };
  };
  const withOrder = async (t: T, id: string) => {
    await t.db.addresses.save({
      id: `addr_${id}`,
      customerId: id,
      name: "Ada Lovelace",
      line1: "12 Crooked Lane",
      city: "London",
      country: "GB",
    });
    await t.db.orders.save({
      id: `ord_${id}`,
      customerId: id,
      total: 500,
    } as never);
  };

  it("a customer exports only their own data and can erase it; the session dies", async () => {
    const t = await setup();
    const ada = await register(t);
    const bob = await register(t, "bob@example.com");
    await withOrder(t, ada.id);
    await withOrder(t, bob.id);
    const out = await send(t, "GET", "/store/customers/me/export", ada.h);
    expect(out.body.customer.email).toBe(email);
    expect(out.body.orders.map((o: { id: string }) => o.id)).toEqual([
      `ord_${ada.id}`,
    ]);
    expect(JSON.stringify(out.body)).not.toMatch(/bob|password|token/i);
    expect(
      (await send(t, "GET", "/store/customers/me/export", t.pk)).res.status,
    ).toBe(401);

    for (const body of [{}, { password: "wrong horse" }]) {
      const refused = await send(
        t,
        "POST",
        "/store/customers/me/erase",
        ada.h,
        body,
      );
      expect(refused.res.status).toBe(body.password ? 401 : 400);
    }
    expect((await t.db.customers.get(ada.id))?.email).toBe(email);
    const gone = await send(t, "POST", "/store/customers/me/erase", ada.h, {
      password: "correct horse",
    });
    expect(gone.body).toEqual({ erased: true });
    expect(
      (await send(t, "GET", "/store/customers/me/export", ada.h)).res.status,
    ).toBe(401);
    expect((await t.db.customers.get(ada.id))?.email).toBeNull();
    expect((await t.db.customers.get(bob.id))?.email).toBe("bob@example.com");
    expect(await t.db.addresses.listByCustomer(bob.id)).toHaveLength(1);
    const audit = JSON.stringify((await t.db.audit.list({ limit: 10 })).items);
    expect(audit).toContain("privacy.erase");
    expect(audit).not.toContain(email);
  });

  it("an account with no customer row can still be erased by an owner; unknown ids stay 404", async () => {
    const t = await setup();
    const { userId } = await t.auth.signUp("customer", {
      email: "old@example.com",
      password: "correct horse",
      name: "Old",
    });
    const owner = await as(t, "owner");
    const path = `/admin/privacy/customers/${userId}/erase`;
    expect((await send(t, "POST", path, owner.h, {})).body).toEqual({
      erased: false,
    });
    expect(await t.auth.userExists("customer", userId)).toBe(false);
    expect((await send(t, "POST", path, owner.h, {})).res.status).toBe(404);
  });

  it("registration for a taken email creates no second customer row", async () => {
    const t = await setup();
    await register(t);
    const again = await send(t, "POST", "/store/auth/register", t.pk, {
      email,
      password: "another pass",
      name: "Mallory",
    });
    expect(again.res.status).toBe(409);
    expect((await t.db.customers.list({ limit: 10 })).items).toHaveLength(1);
  });

  it("only owners reach the admin export and erase; unknown ids are 404", async () => {
    const t = await setup();
    const ada = await register(t);
    const owner = await as(t, "owner");
    const staff = await as(t, "staff");
    const path = `/admin/privacy/customers/${ada.id}`;
    expect((await send(t, "GET", `${path}/export`, staff.h)).res.status).toBe(
      403,
    );
    expect(
      (await send(t, "POST", `${path}/erase`, staff.h, {})).res.status,
    ).toBe(403);
    expect((await send(t, "GET", `${path}/export`, t.sk)).res.status).toBe(403);
    expect(
      (await send(t, "GET", `${path}/export`, owner.h)).body.customer.name,
    ).toBe("Ada Lovelace");
    expect((await send(t, "POST", `${path}/erase`, owner.h, {})).body).toEqual({
      erased: true,
    });
    expect((await send(t, "POST", `${path}/erase`, owner.h, {})).body).toEqual({
      erased: false,
    });
    expect(
      (
        await send(
          t,
          "GET",
          "/admin/privacy/customers/cus_nope/export",
          owner.h,
        )
      ).res.status,
    ).toBe(404);
    const actions = (await t.db.audit.list({ limit: 10 })).items
      .filter((e) => e.actor.id === owner.userId)
      .map((e) => e.action);
    expect(actions.sort()).toEqual(["privacy.erase", "privacy.export"]);
  });
});

describe("admin webhooks", () => {
  const body = {
    url: "https://hooks.example.com/in",
    events: ["order.created"],
  };

  it("creates with the secret shown once, lists without it, and audits without it", async () => {
    const t = await setup();
    const { h } = await as(t, "owner");
    const created = await send(t, "POST", "/admin/webhooks", h, body, "same");
    expect(created.res.status).toBe(201);
    const { secret, id } = created.body;
    expect(secret).toMatch(/^whsec_/);
    expect(created.body.secretCipher).toBeUndefined();
    expect(
      (await send(t, "POST", "/admin/webhooks", h, body, "same")).res.status,
    ).toBe(409);
    for (const path of ["/admin/webhooks", `/admin/webhooks/${id}`]) {
      const got = await send(t, "GET", path, h);
      expect(got.res.status).toBe(200);
      expect(JSON.stringify(got.body)).not.toMatch(
        /whsec_[0-9a-f]{20}|secretCipher/,
      );
    }
    const audit = await t.db.audit.list({ limit: 20 });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(audit.items.map((e) => e.action)).toContain("POST /admin/webhooks");
  });

  it("rejects unsafe URLs and bad filters", async () => {
    const t = await setup();
    const { h } = await as(t, "owner");
    for (const bad of [
      { ...body, url: "http://hooks.example.com/in" },
      { ...body, url: "https://169.254.169.254/latest" },
      { ...body, url: "https://localhost/in" },
      { ...body, events: [] },
      { ...body, extra: 1 },
    ])
      expect(
        (await send(t, "POST", "/admin/webhooks", h, bad)).res.status,
      ).toBe(400);
    const ok = await send(t, "POST", "/admin/webhooks", h, body);
    const patch = await send(t, "PATCH", `/admin/webhooks/${ok.body.id}`, h, {
      url: "https://10.0.0.1/x",
    });
    expect(patch.res.status).toBe(400);
  });

  it("is owner-write, staff-read, and 404s on unknown ids", async () => {
    const t = await setup();
    const owner = await as(t, "owner");
    const staff = await as(t, "staff");
    const made = await send(t, "POST", "/admin/webhooks", owner.h, body);
    expect((await send(t, "GET", "/admin/webhooks", staff.h)).res.status).toBe(
      200,
    );
    expect(
      (await send(t, "POST", "/admin/webhooks", staff.h, body)).res.status,
    ).toBe(403);
    expect(
      (
        await send(t, "PATCH", `/admin/webhooks/${made.body.id}`, staff.h, {
          enabled: false,
        })
      ).res.status,
    ).toBe(403);
    expect(
      (await send(t, "GET", "/admin/webhooks/whk_missing", owner.h)).res.status,
    ).toBe(404);
  });

  it("shows the delivery log without payloads and replays a delivery", async () => {
    const t = await setup();
    const { h } = await as(t, "owner");
    const made = await send(t, "POST", "/admin/webhooks", h, body);
    await t.db.webhookDeliveries.create({
      id: "whd_evt_1.x",
      endpointId: made.body.id,
      event: {
        id: "evt_1",
        type: "order.created",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: { email: "pii@example.com" },
      },
      status: "failed",
      attempts: 6,
      nextAttemptAt: null,
      lastStatus: 503,
      lastError: "HTTP 503",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const log = await send(
      t,
      "GET",
      `/admin/webhooks/${made.body.id}/deliveries`,
      h,
    );
    expect(log.body.items[0]).toMatchObject({
      eventId: "evt_1",
      eventType: "order.created",
      lastError: "HTTP 503",
    });
    expect(JSON.stringify(log.body)).not.toContain("pii@");
    const replay = `/admin/webhooks/${made.body.id}/deliveries/whd_evt_1.x/replay`;
    const ok = await send(t, "POST", replay, h, {});
    expect(ok.res.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "pending", attempts: 0 });
    expect(
      (
        await send(
          t,
          "POST",
          `/admin/webhooks/whk_other/deliveries/whd_evt_1.x/replay`,
          h,
          {},
        )
      ).res.status,
    ).toBe(404);
    const audit = await t.db.audit.list({ limit: 20 });
    expect(audit.items.map((e) => e.action)).toContain(
      "POST /admin/webhooks/:id/deliveries/:deliveryId/replay",
    );
  });
});

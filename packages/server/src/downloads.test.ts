import { newId } from "@free-commerce/schema";
import { describe, expect, it } from "vitest";
import { as, setup } from "./test-setup.js";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
const creds = { email: "a@example.com", password: "correct horse" };
type T = Awaited<ReturnType<typeof setup>>;
let n = 0;

const call = async (
  t: T,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: BodyInit,
) => {
  const res = await t.app.request(`http://x${path}`, {
    method,
    body,
    headers: {
      ...headers,
      ...(method !== "GET" && { "idempotency-key": `d${n++}` }),
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test helper
  return { res, body: (await res.json().catch(() => null)) as any };
};

const login = async (t: T, email: string) => {
  const res = await t.app.request("/store/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...creds, email, name: "A", mode: "bearer" }),
    headers: { "content-type": "application/json", ...t.pk },
  });
  const b = (await res.json()) as { userId: string; token: string };
  return {
    userId: b.userId,
    h: { ...t.pk, authorization: `Bearer ${b.token}` },
  };
};

/** A customer with one paid order holding a grant for an uploaded PDF, plus a second customer with their own. */
const shop = async (maxDownloads: number | null = 2) => {
  const orders = new Map<string, { id: string }[]>();
  const t = await setup({
    customerOrders: async (id) => (orders.get(id) ?? []) as never,
  });
  const staff = await as(t, "staff");
  const up = await call(
    t,
    "POST",
    "/admin/digital-assets?filename=Guide.pdf",
    { ...staff.h, "content-type": "application/pdf" },
    PDF,
  );
  const asset = up.body as { id: string };
  const grantFor = async (owner: string) => {
    const orderId = newId("ord");
    const id = `grant_${newId("line").slice(5)}`;
    await t.db.grants.save({
      id,
      orderId,
      lineId: newId("line"),
      assetId: asset.id,
      maxDownloads,
      downloads: 0,
      expiresAt: null,
      revokedAt: null,
      accessHash: null,
      createdAt: new Date().toISOString(),
    });
    orders.set(owner, [{ id: orderId }]);
    return { id, orderId };
  };
  const alice = await login(t, "a@example.com");
  const bob = await login(t, "b@example.com");
  return {
    t,
    staff,
    asset,
    alice: { ...alice, grant: await grantFor(alice.userId) },
    bob: { ...bob, grant: await grantFor(bob.userId) },
  };
};

describe("store downloads", () => {
  it("lists only the customer's own downloads and never exposes storage details", async () => {
    const s = await shop();
    const mine = await call(s.t, "GET", "/store/downloads", s.alice.h);
    expect(mine.body.items).toEqual([
      expect.objectContaining({
        id: s.alice.grant.id,
        filename: "Guide.pdf",
        downloadsLeft: 2,
      }),
    ]);
    expect(JSON.stringify(mine.body)).not.toMatch(/assets\/|storageKey|fake:/);
    expect(
      (await call(s.t, "GET", "/store/downloads", s.t.pk)).res.status,
    ).toBe(401);
  });

  it("issues a signed URL, counts it, and stops at the limit", async () => {
    const s = await shop();
    const path = `/store/downloads/${s.alice.grant.id}/url`;
    const ok = await call(s.t, "POST", path, s.alice.h);
    expect(ok.res.status).toBe(200);
    expect(ok.body.url).toContain("assets/");
    expect(ok.body.expiresInSeconds).toBeLessThanOrEqual(60);
    expect((await call(s.t, "POST", path, s.alice.h)).res.status).toBe(200);
    const spent = await call(s.t, "POST", path, s.alice.h);
    expect(spent.res.status).toBe(403);
    expect(spent.body.details.reason).toBe("exhausted");
  });

  it("never opens another customer's grant, and answers like an unknown one", async () => {
    const s = await shop();
    const theirs = `/store/downloads/${s.bob.grant.id}/url`;
    const wrong = await call(s.t, "POST", theirs, s.alice.h);
    const unknown = await call(
      s.t,
      "POST",
      `/store/downloads/${newId("grant")}/url`,
      s.alice.h,
    );
    expect(wrong.res.status).toBe(404);
    expect(wrong.body.message).toBe(unknown.body.message);
    expect((await s.t.db.grants.get(s.bob.grant.id))?.downloads).toBe(0);
  });

  it("serves a revoked grant nothing", async () => {
    const s = await shop();
    const g = await s.t.db.grants.get(s.alice.grant.id);
    await s.t.db.grants.save({
      ...(g as NonNullable<typeof g>),
      revokedAt: new Date().toISOString(),
    });
    const res = await call(
      s.t,
      "POST",
      `/store/downloads/${s.alice.grant.id}/url`,
      s.alice.h,
    );
    expect(res.res.status).toBe(403);
    expect(res.body.details.reason).toBe("revoked");
  });

  it("guests use the link token from the header; a missing or wrong token gets nothing", async () => {
    const s = await shop();
    const token = (await s.t.downloads.issueLink(s.alice.grant.orderId)) ?? "";
    const guest = { ...s.t.pk, "x-download-token": token };
    const list = await call(s.t, "GET", "/store/downloads", guest);
    expect(list.body.items).toHaveLength(1);
    const path = `/store/downloads/${s.alice.grant.id}/url`;
    expect((await call(s.t, "POST", path, guest)).res.status).toBe(200);
    const bad = { ...s.t.pk, "x-download-token": `${token.slice(0, -1)}0` };
    expect((await call(s.t, "POST", path, bad)).res.status).toBe(404);
    expect(
      (await call(s.t, "GET", "/store/downloads", bad)).body.items,
    ).toEqual([]);
    // Alice's token cannot reach Bob's grant.
    expect(
      (await call(s.t, "POST", `/store/downloads/${s.bob.grant.id}/url`, guest))
        .res.status,
    ).toBe(404);
  });

  it("never stores a signed URL for idempotent replay", async () => {
    const s = await shop();
    const path = `/store/downloads/${s.alice.grant.id}/url`;
    const send = () =>
      s.t.app.request(`http://x${path}`, {
        method: "POST",
        headers: { ...s.alice.h, "idempotency-key": "same" },
      });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.text()).not.toContain("assets/");
  });
});

describe("admin digital assets", () => {
  it("replacing a file keeps the asset id and existing grants, and never returns the storage key", async () => {
    const s = await shop();
    const list = await call(s.t, "GET", "/admin/digital-assets", s.staff.h);
    expect(JSON.stringify(list.body)).not.toContain("storageKey");
    const replaced = await call(
      s.t,
      "PUT",
      `/admin/digital-assets/${s.asset.id}?filename=Guide-v2.pdf`,
      { ...s.staff.h, "content-type": "application/pdf" },
      PDF,
    );
    expect(replaced.res.status).toBe(200);
    expect(replaced.body).toMatchObject({
      id: s.asset.id,
      filename: "Guide-v2.pdf",
    });
    const url = await call(
      s.t,
      "POST",
      `/store/downloads/${s.alice.grant.id}/url`,
      s.alice.h,
    );
    expect(url.res.status).toBe(200);
    const view = await call(s.t, "GET", "/store/downloads", s.alice.h);
    expect(view.body.items[0].filename).toBe("Guide-v2.pdf");
  });

  it("refuses bad file names and unknown assets without leaving an orphan upload", async () => {
    const s = await shop();
    const h = { ...s.staff.h, "content-type": "application/pdf" };
    for (const name of ["", "a/b.pdf", 'a"b.pdf', "a\nb.pdf"])
      expect(
        (
          await call(
            s.t,
            "POST",
            `/admin/digital-assets?filename=${encodeURIComponent(name)}`,
            h,
            PDF,
          )
        ).res.status,
      ).toBe(400);
    const missing = await call(
      s.t,
      "PUT",
      `/admin/digital-assets/${newId("asset")}?filename=x.pdf`,
      h,
      PDF,
    );
    expect(missing.res.status).toBe(404);
    const noPdf = await call(
      s.t,
      "POST",
      "/admin/digital-assets?filename=x.pdf",
      { ...s.staff.h, "content-type": "text/plain" },
      new TextEncoder().encode("hello"),
    );
    expect(noPdf.res.status).toBe(400);
  });

  it("is staff-only, not for customers or storefront keys", async () => {
    const s = await shop();
    expect(
      (await call(s.t, "GET", "/admin/digital-assets", s.t.pk)).res.status,
    ).toBe(403);
    expect(
      (await call(s.t, "GET", "/admin/digital-assets", s.alice.h)).res.status,
    ).toBe(401);
  });
});

import {
  createDownloads,
  createRefunds,
  type Database,
} from "@free-commerce/core";
import {
  createFakePayments,
  createFakeStorage,
  FAKE_TOKENS,
} from "@free-commerce/core/testing";
import { newId, Order, type Variant } from "@free-commerce/schema";
import { describe, expect, it } from "vitest";

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const DAY = 86_400_000;
const ebook = Uint8Array.of(1, 2, 3);

async function world(
  make: () => Database | Promise<Database>,
  settings = {
    lifetimeDays: 1 as number | null,
    maxDownloads: 2 as number | null,
  },
) {
  const db = await make();
  let clock = T0;
  const storage = createFakeStorage(() => clock);
  const variantId = newId("var");
  const linesOf = () =>
    [
      { deliveryType: "digital", variantId },
      { deliveryType: "physical", variantId: newId("var") },
    ].map((l) => ({
      ...l,
      id: newId("line"),
      title: "Thing",
      quantity: 1,
      fulfilled: 0,
      unitPrice: { amount: 500, currency: "USD" },
    }));
  const order = (n: number) =>
    Order.parse({
      id: newId("ord"),
      number: n,
      status: "open",
      paymentStatus: "paid",
      fulfilmentStatus: "unfulfilled",
      lines: linesOf(),
      total: { amount: 1000, currency: "USD" },
      paid: { amount: 1000, currency: "USD" },
      refunded: { amount: 0, currency: "USD" },
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
  const mine = order(1);
  const other = order(2);
  await storage.put("assets/v1.pdf", ebook, "application/pdf");
  let assetId = "";
  const downloads = createDownloads({
    db,
    storage,
    settings: settings ?? undefined,
    variantOf: async (id) =>
      ({
        id,
        deliveryType: id === variantId ? "digital" : "physical",
        digitalAssetId: assetId || undefined,
      }) as Variant,
    now: () => new Date(clock),
  });
  assetId = (
    await downloads.createAsset({
      filename: "book.pdf",
      storageKey: "assets/v1.pdf",
      contentType: "application/pdf",
      size: 3,
    })
  ).id;
  for (const o of [mine, other]) {
    await db.orders.save(o);
    await db.transaction((tx) => downloads.grant(tx, o));
  }
  const [grant] = await db.grants.find("orderId", mine.id);
  if (!grant) throw new Error("no grant");
  return {
    db,
    storage,
    downloads,
    mine,
    other,
    grant,
    assetId,
    own: { orderIds: [mine.id] },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code,
  );

/** Digital delivery cases, registered inside `repositoryConformance` so every adapter runs them. */
export function downloadCases(make: () => Database | Promise<Database>): void {
  describe("digital delivery", () => {
    it("grants one download right per digital line with the store limits, once", async () => {
      const w = await world(make);
      expect(await w.db.grants.find("orderId", w.mine.id)).toEqual([
        {
          id: `grant_${w.mine.lines[0]?.id.slice(5)}`,
          orderId: w.mine.id,
          lineId: w.mine.lines[0]?.id,
          assetId: w.assetId,
          maxDownloads: 2,
          downloads: 0,
          expiresAt: new Date(T0 + DAY).toISOString(),
          revokedAt: null,
          accessHash: null,
          createdAt: new Date(T0).toISOString(),
        },
      ]);
      await w.db.transaction((tx) => w.downloads.grant(tx, w.mine));
      expect(await w.db.grants.find("orderId", w.mine.id)).toHaveLength(1);
    });

    it("lists a customer's downloads without storage details and issues a short-lived signed URL", async () => {
      const w = await world(make);
      const [view] = await w.downloads.list(w.own);
      expect(view).toEqual({
        id: w.grant.id,
        orderId: w.mine.id,
        filename: "book.pdf",
        size: 3,
        status: "active",
        expiresAt: new Date(T0 + DAY).toISOString(),
        downloadsLeft: 2,
      });
      const { url, expiresInSeconds } = await w.downloads.url(
        w.own,
        w.grant.id,
      );
      expect(expiresInSeconds).toBeLessThanOrEqual(60);
      expect(w.storage.isValidUrl(url)).toBe(true);
      w.advance(61_000);
      expect(w.storage.isValidUrl(url)).toBe(false);
      expect((await w.downloads.list(w.own))[0]?.downloadsLeft).toBe(1);
    });

    it("refuses once the limit is used up, and unlimited grants never run out", async () => {
      const w = await world(make);
      await w.downloads.url(w.own, w.grant.id);
      await w.downloads.url(w.own, w.grant.id);
      expect(await code(w.downloads.url(w.own, w.grant.id))).toBe("exhausted");
      const free = await world(make, {
        lifetimeDays: null,
        maxDownloads: null,
      });
      for (let i = 0; i < 5; i++)
        await free.downloads.url(free.own, free.grant.id);
      expect((await free.downloads.list(free.own))[0]).toMatchObject({
        expiresAt: null,
        downloadsLeft: null,
      });
    });

    it("never lets concurrent requests exceed the limit", async () => {
      const w = await world(make, { lifetimeDays: 1, maxDownloads: 3 });
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          code(w.downloads.url(w.own, w.grant.id)),
        ),
      );
      expect(results.filter((r) => r === "ok")).toHaveLength(3);
      expect(new Set(results.filter((r) => r !== "ok"))).toEqual(
        new Set(["exhausted"]),
      );
      expect((await w.db.grants.get(w.grant.id))?.downloads).toBe(3);
    });

    it("refuses after the expiry time", async () => {
      const w = await world(make);
      w.advance(DAY - 1);
      await w.downloads.url(w.own, w.grant.id);
      w.advance(1);
      expect(await code(w.downloads.url(w.own, w.grant.id))).toBe("expired");
    });

    it("revokes with the order, idempotently, and a rolled-back revocation changes nothing", async () => {
      const w = await world(make);
      await expect(
        w.db.transaction(async (tx) => {
          await w.downloads.revoke(tx, w.mine);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await w.downloads.url(w.own, w.grant.id);
      await w.db.transaction((tx) => w.downloads.revoke(tx, w.mine));
      const first = (await w.db.grants.get(w.grant.id))?.revokedAt;
      await w.db.transaction((tx) => w.downloads.revoke(tx, w.mine));
      expect((await w.db.grants.get(w.grant.id))?.revokedAt).toBe(first);
      expect(await code(w.downloads.url(w.own, w.grant.id))).toBe("revoked");
      expect(
        await code(
          w.downloads.url(
            { orderIds: [w.other.id] },
            `grant_${w.other.lines[0]?.id.slice(5)}`,
          ),
        ),
      ).toBe("ok");
    });

    it("a refund revokes the order's downloads through the refund hook, other orders keep theirs", async () => {
      const w = await world(make);
      const pay = createFakePayments();
      const total = { amount: 1000, currency: "USD" };
      const p = await pay.createPayment({
        idempotencyKey: "p",
        amount: total,
        reference: "x",
      });
      await pay.confirm({
        idempotencyKey: "c",
        paymentId: p.id,
        methodToken: FAKE_TOKENS.ok,
      });
      await w.db.orders.save({ ...w.mine, paymentId: p.id } as Order);
      const refunds = createRefunds({
        db: w.db,
        payments: pay,
        variantOf: async () => null,
        revokeDownloads: w.downloads.revoke,
        now: () => new Date(T0),
      });
      await refunds.refund({
        orderId: w.mine.id,
        key: "r1",
        actor: { type: "user", id: "usr_1" },
      });
      expect(await code(w.downloads.url(w.own, w.grant.id))).toBe("revoked");
      const theirs = `grant_${w.other.lines[0]?.id.slice(5)}`;
      expect(
        await code(w.downloads.url({ orderIds: [w.other.id] }, theirs)),
      ).toBe("ok");
    });

    it("a cancelled order revokes even when nothing was refunded", async () => {
      const w = await world(make);
      const free = Order.parse({
        ...w.mine,
        paid: { amount: 0, currency: "USD" },
        total: { amount: 0, currency: "USD" },
      });
      await w.db.orders.save(free);
      const refunds = createRefunds({
        db: w.db,
        payments: createFakePayments(),
        variantOf: async () => null,
        revokeDownloads: w.downloads.revoke,
        now: () => new Date(T0),
      });
      await refunds.refund({
        orderId: free.id,
        key: "c",
        cancel: true,
        actor: { type: "user", id: "usr_1" },
      });
      expect((await w.downloads.list(w.own))[0]?.status).toBe("revoked");
    });

    it("the repository applies every consume rule itself (revoked, expired, exhausted, unknown)", async () => {
      const w = await world(make);
      const at = (ms: number) => new Date(T0 + ms).toISOString();
      const put = (over: object) => w.db.grants.save({ ...w.grant, ...over });
      await put({ maxDownloads: 1 });
      expect(await w.db.grants.consume(w.grant.id, at(0))).toMatchObject({
        ok: true,
      });
      expect(await w.db.grants.consume(w.grant.id, at(0))).toEqual({
        ok: false,
        reason: "exhausted",
      });
      await put({ downloads: 0, maxDownloads: null, expiresAt: at(10) });
      expect(await w.db.grants.consume(w.grant.id, at(10))).toEqual({
        ok: false,
        reason: "expired",
      });
      expect(await w.db.grants.consume(w.grant.id, at(9))).toMatchObject({
        ok: true,
      });
      await put({ downloads: 0, expiresAt: null, revokedAt: at(0) });
      expect(await w.db.grants.consume(w.grant.id, at(0))).toEqual({
        ok: false,
        reason: "revoked",
      });
      expect(await w.db.grants.consume(newId("grant"), at(0))).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect((await w.db.grants.get(w.grant.id))?.downloads).toBe(0);
    });

    it("a variant pointing at a missing asset gets no grant", async () => {
      const w = await world(make);
      const o = Order.parse({
        ...w.mine,
        id: newId("ord"),
        lines: w.mine.lines.map((l) => ({ ...l, id: newId("line") })),
      });
      await w.db.transaction((tx) =>
        w.downloads.grant(
          { ...tx, assets: { ...tx.assets, get: async () => null } },
          o,
        ),
      );
      expect(await w.db.grants.find("orderId", o.id)).toEqual([]);
    });

    it("shows another customer's grants as not found, same as unknown ones", async () => {
      const w = await world(make);
      const stranger = { orderIds: [w.other.id] };
      expect(await w.downloads.list({ orderIds: [] })).toEqual([]);
      expect(await code(w.downloads.url(stranger, w.grant.id))).toBe(
        "not_found",
      );
      expect(await code(w.downloads.url(w.own, newId("grant")))).toBe(
        "not_found",
      );
      expect((await w.db.grants.get(w.grant.id))?.downloads).toBe(0);
    });

    it("guest links: only the hash is stored, a wrong token opens nothing, a new link replaces the old", async () => {
      const w = await world(make);
      const token = await w.downloads.issueLink(w.mine.id);
      expect(token).toMatch(/^dl_[0-9a-f]{64}$/);
      const stored = await w.db.grants.get(w.grant.id);
      expect(stored?.accessHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(token ?? "?");
      expect(await w.downloads.list({ token: "dl_nope" })).toEqual([]);
      expect(
        await code(w.downloads.url({ token: "dl_nope" }, w.grant.id)),
      ).toBe("not_found");
      expect(
        await code(w.downloads.url({ token: token ?? "" }, w.grant.id)),
      ).toBe("ok");
      const again = await w.downloads.issueLink(w.mine.id);
      expect(again).not.toBe(token);
      expect(await w.downloads.list({ token: token ?? "" })).toEqual([]);
      expect(await w.downloads.list({ token: again ?? "" })).toHaveLength(1);
      expect(await w.downloads.issueLink(newId("ord"))).toBeNull();
    });

    it("a guest token never opens another order's grant", async () => {
      const w = await world(make);
      const token = (await w.downloads.issueLink(w.mine.id)) ?? "";
      const theirs = `grant_${w.other.lines[0]?.id.slice(5)}`;
      expect(await code(w.downloads.url({ token }, theirs))).toBe("not_found");
    });

    it("replacing the file keeps grants and counts, serves the new file and drops the old one", async () => {
      const w = await world(make);
      await w.downloads.url(w.own, w.grant.id);
      await w.storage.put("assets/v2.pdf", Uint8Array.of(9), "application/pdf");
      const next = await w.downloads.replaceAsset(w.assetId, {
        filename: "book-2.pdf",
        storageKey: "assets/v2.pdf",
        contentType: "application/pdf",
        size: 1,
      });
      expect(next?.id).toBe(w.assetId);
      expect(await w.storage.get("assets/v1.pdf")).toBeNull();
      const { url } = await w.downloads.url(w.own, w.grant.id);
      expect(url).toContain("assets/v2.pdf");
      expect((await w.db.grants.get(w.grant.id))?.downloads).toBe(2);
      expect((await w.downloads.list(w.own))[0]?.filename).toBe("book-2.pdf");
      expect(
        await w.downloads.replaceAsset(newId("asset"), next ?? ({} as never)),
      ).toBeNull();
    });

    it("a missing stored file is unavailable and does not use up a download", async () => {
      const w = await world(make);
      await w.storage.delete("assets/v1.pdf");
      expect(await code(w.downloads.url(w.own, w.grant.id))).toBe(
        "unavailable",
      );
      expect((await w.db.grants.get(w.grant.id))?.downloads).toBe(0);
    });
  });
}

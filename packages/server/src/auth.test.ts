import { createApiKey, revokeApiKey, verifyApiKey } from "@free-commerce/core";
import { createFakeAuth } from "@free-commerce/core/testing";
import { describe, expect, it } from "vitest";
import { post, setup } from "./test-setup.js";

const creds = { email: "a@example.com", password: "correct horse" };
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});
type Login = { userId: string; token: string };

/** Registers a customer in bearer mode and returns request headers that act as them. */
const customer = async (
  t: Awaited<ReturnType<typeof setup>>,
  email = creds.email,
) => {
  const res = await t.app.request(
    "/store/auth/register",
    json({ ...creds, email, name: "A", mode: "bearer" }, t.pk),
  );
  const body = (await res.json()) as Login;
  return {
    ...t.pk,
    authorization: `Bearer ${body.token}`,
    userId: body.userId,
  };
};

const admin = async (t: Awaited<ReturnType<typeof setup>>) => {
  await t.auth.signUp("admin", { ...creds, name: "Boss" }).catch(() => {});
  const res = await t.app.request(
    "/admin/auth/login",
    json({ ...creds, mode: "bearer" }),
  );
  return { authorization: `Bearer ${((await res.json()) as Login).token}` };
};

describe("admin boundary", () => {
  it("rejects unauthenticated requests", async () => {
    const { app } = await setup();
    const res = await app.request("/admin/ping");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("rejects publishable keys and customer sessions", async () => {
    const t = await setup();
    expect((await t.app.request("/admin/ping", { headers: t.pk })).status).toBe(
      403,
    );
    const c = await customer(t);
    // A customer token is not an admin token: unknown in the admin realm.
    expect((await t.app.request("/admin/ping", { headers: c })).status).toBe(
      401,
    );
  });

  it("admin sessions pass; an admin token is useless on /store", async () => {
    const t = await setup();
    const a = await admin(t);
    expect((await t.app.request("/admin/ping", { headers: a })).status).toBe(
      200,
    );
    const res = await t.app.request("/store/orders", {
      headers: { ...t.pk, ...a },
    });
    expect(res.status).toBe(401);
  });

  it("secret keys are limited to their scopes", async () => {
    const t = await setup();
    const { secret } = await createApiKey(t.apiKeys, {
      type: "secret",
      name: "reader",
      scopes: ["admin:read"],
    });
    const h = { "x-api-key": secret };
    expect((await t.app.request("/admin/ping", { headers: h })).status).toBe(
      200,
    );
    const write = await t.app.fetch(post({}, "k", "/admin/ping", h));
    expect(write.status).toBe(403);
  });

  it("cookie-authenticated writes need an allowed Origin", async () => {
    const t = await setup();
    t.app.post("/admin/thing", (c) => c.json({ ok: true }));
    await t.auth.signUp("admin", { ...creds, name: "Boss" });
    const login = await t.app.request("/admin/auth/login", json(creds));
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(login.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    const attempt = (origin?: string) =>
      t.app.fetch(
        post({}, `k-${origin}`, "/admin/thing", {
          cookie,
          ...(origin && { origin }),
        }),
      );
    expect((await attempt()).status).toBe(403);
    expect((await attempt("https://evil.example")).status).toBe(403);
    expect((await attempt("https://shop.example")).status).toBe(200);
    expect(
      (await t.app.request("/admin/ping", { headers: { cookie } })).status,
    ).toBe(200);
  });

  it("login failure and signed-out tokens are unauthenticated", async () => {
    const t = await setup();
    await t.auth.signUp("admin", { ...creds, name: "Boss" });
    const bad = await t.app.request(
      "/admin/auth/login",
      json({ ...creds, password: "wrong horse" }),
    );
    expect(bad.status).toBe(401);
    const a = await admin(t);
    await t.app.request("/admin/auth/logout", { method: "POST", headers: a });
    expect((await t.app.request("/admin/ping", { headers: a })).status).toBe(
      401,
    );
  });
});

describe("API keys", () => {
  it("the storefront needs a key", async () => {
    const { app } = await setup();
    expect((await app.request("/store/orders")).status).toBe(401);
    const res = await app.request("/store/orders", {
      headers: { "x-api-key": "pk_unknown" },
    });
    expect(res.status).toBe(401);
  });

  it("a revoked key stops working immediately", async () => {
    const t = await setup();
    expect(
      (await t.app.request("/store/auth/logout", json({}, t.pk))).status,
    ).toBe(200);
    const key = await verifyApiKey(t.apiKeys, t.pk["x-api-key"]);
    await revokeApiKey(t.apiKeys, key?.id ?? "");
    const res = await t.app.request("/store/auth/logout", json({}, t.pk));
    expect(res.status).toBe(401);
  });

  it("a read-only key cannot write", async () => {
    const t = await setup();
    const { secret } = await createApiKey(t.apiKeys, {
      type: "publishable",
      name: "catalog",
      scopes: ["read"],
    });
    const res = await t.app.fetch(
      post({ message: "x" }, "k", "/store/echo", { "x-api-key": secret }),
    );
    expect(res.status).toBe(403);
  });
});

describe("customers", () => {
  it("register, log in with a cookie, and read only their own orders", async () => {
    const orders = new Map<string, { id: string }[]>();
    const t = await setup({
      customerOrders: async (id) => (orders.get(id) ?? []) as never,
    });
    const reg = await t.app.request(
      "/store/auth/register",
      json({ ...creds, name: "A" }, t.pk),
    );
    expect(reg.status).toBe(201);
    expect(await reg.clone().text()).not.toMatch(/token/);
    const cookie = (reg.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { userId } = (await reg.json()) as Login;
    const other = await customer(t, "b@example.com");
    orders.set(userId, [{ id: "ord_MINE" }]);
    orders.set(other.userId, [{ id: "ord_THEIRS" }]);

    const mine = await t.app.request("/store/orders", {
      headers: { ...t.pk, cookie },
    });
    expect(await mine.json()).toEqual([{ id: "ord_MINE" }]);
    const theirs = await t.app.request("/store/orders/ord_THEIRS", {
      headers: { ...t.pk, cookie },
    });
    expect(theirs.status).toBe(404);
    const anon = await t.app.request("/store/orders", { headers: t.pk });
    expect(anon.status).toBe(401);
  });

  it("registering a taken email or logging in wrongly fails without a session", async () => {
    const t = await setup();
    await customer(t);
    const dup = await t.app.request(
      "/store/auth/register",
      json({ ...creds, password: "another horse", name: "X" }, t.pk),
    );
    expect(dup.status).toBe(409);
    expect(dup.headers.get("set-cookie")).toBeNull();
    const bad = await t.app.request(
      "/store/auth/login",
      json({ ...creds, password: "wrong horse" }, t.pk),
    );
    expect(bad.status).toBe(401);
  });

  it("expired sessions are unauthenticated", async () => {
    let now = Date.now();
    const t = await setup({ auth: createFakeAuth(() => now) });
    const c = await customer(t);
    now += 2 * 3600 * 1000;
    expect((await t.app.request("/store/orders", { headers: c })).status).toBe(
      401,
    );
  });

  it("login is throttled and its response is never stored for replay", async () => {
    const t = await setup();
    await customer(t);
    const login = () =>
      t.app.request("/store/auth/login", {
        ...json(
          { ...creds, mode: "bearer" },
          { ...t.pk, "idempotency-key": "same" },
        ),
      });
    const a = (await (await login()).json()) as Login;
    const b = (await (await login()).json()) as Login;
    expect(a.token).not.toBe(b.token);
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await login()).status;
    expect(last).toBe(429);
  });
});

describe("CORS", () => {
  it("answers preflight only for allowed origins", async () => {
    const { app } = await setup();
    const pre = (origin: string) =>
      app.request("/store/orders", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
    const ok = await pre("https://shop.example");
    expect(ok.headers.get("access-control-allow-origin")).toBe(
      "https://shop.example",
    );
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(
      (await pre("https://evil.example")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
  });
});

describe("idempotency scoping", () => {
  it("one principal's key cannot replay another's response", async () => {
    const t = await setup();
    let n = 0;
    t.app.post("/store/count", (c) => c.json({ n: ++n }));
    const a = await customer(t, "a@example.com");
    const b = await customer(t, "b@example.com");
    const run = (h: Record<string, string>) =>
      t.app.fetch(post({}, "shared", "/store/count", h));
    expect(await (await run(a)).json()).toEqual({ n: 1 });
    expect(await (await run(b)).json()).toEqual({ n: 2 });
    expect((await run(a)).headers.get("idempotent-replayed")).toBe("true");
  });

  it("concurrent requests with one key run the handler once", async () => {
    const t = await setup();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    t.app.post("/store/slow", async (c) => {
      calls++;
      await gate;
      return c.json({ ok: true });
    });
    const first = t.app.fetch(post({}, "k", "/store/slow", t.pk));
    await new Promise((r) => setTimeout(r, 10));
    const second = await t.app.fetch(post({}, "k", "/store/slow", t.pk));
    expect(second.status).toBe(409);
    expect(second.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(200);
    const replay = await t.app.fetch(post({}, "k", "/store/slow", t.pk));
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(calls).toBe(1);
  });
});

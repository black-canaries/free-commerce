import { describe, expect, it } from "vitest";
import { HttpError, memoryRateLimitStore } from "./index.js";
import { post, setup } from "./test-setup.js";

describe("request context", () => {
  it("logs and traces with the same inbound request id", async () => {
    const { app, logs, spans } = await setup();
    const res = await app.request("/health", {
      headers: { "x-request-id": "req-1" },
    });
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(logs[0]).toMatchObject({
      requestId: "req-1",
      msg: "request",
      status: 200,
    });
    expect(spans[0]?.attrs).toMatchObject({
      "request.id": "req-1",
      "http.status_code": 200,
    });
  });

  it("replaces an unsafe inbound id", async () => {
    const { app } = await setup();
    const res = await app.request("/health", {
      headers: { "x-request-id": "bad id\n" },
    });
    expect(res.headers.get("x-request-id")).not.toContain("bad");
  });
});

describe("/ready", () => {
  it("is 200 when the db is up and 503 when down", async () => {
    expect((await (await setup()).app.request("/ready")).status).toBe(200);
    const down = await setup({
      checkDb: async () => {
        throw new Error("secret-dsn");
      },
    });
    const res = await down.app.request("/ready");
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("secret-dsn");
  });
});

describe("errors", () => {
  it("validation error carries field details", async () => {
    const { app, pk } = await setup();
    const res = await app.fetch(post({ message: "" }, "k1", undefined, pk));
    const json = (await res.json()) as {
      code: string;
      details: { fieldErrors: Record<string, unknown> };
    };
    expect(res.status).toBe(400);
    expect(json.code).toBe("validation_failed");
    expect(json.details.fieldErrors.message).toBeDefined();
  });

  it("validates query via schema defaults and coercion", async () => {
    const { app, sk } = await setup();
    const get = (q: string) => app.request(`/admin/ping?${q}`, { headers: sk });
    expect(await (await get("limit=5")).json()).toEqual({ limit: 5 });
    expect((await get("limit=0")).status).toBe(400);
  });

  it("unknown route is a typed not_found", async () => {
    const res = await (await setup()).app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("thrown errors are typed internal without stack leak", async () => {
    const { app, logs } = await setup();
    app.get("/boom", () => {
      throw new Error("db password hunter2");
    });
    const res = await app.request("/boom");
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text).code).toBe("internal");
    expect(text).not.toMatch(/hunter2|at .*\.ts/);
    expect(logs.some((l) => l.msg === "unhandled error")).toBe(true);
  });

  it("maps HttpError codes to statuses", async () => {
    const { app } = await setup();
    app.get("/f", () => {
      throw new HttpError("forbidden", "no");
    });
    expect((await app.request("/f")).status).toBe(403);
  });
});

describe("idempotency", () => {
  it("requires a key on mutating requests", async () => {
    const { app, pk } = await setup();
    const res = await app.fetch(
      post({ message: "a" }, undefined, undefined, pk),
    );
    expect(res.status).toBe(400);
  });

  it("replays the stored response for the same key and request", async () => {
    const { app, pk } = await setup();
    let calls = 0;
    app.post("/store/count", (c) => c.json({ n: ++calls }));
    const first = await app.fetch(post({}, "k", "/store/count", pk));
    const second = await app.fetch(post({}, "k", "/store/count", pk));
    expect(await first.json()).toEqual({ n: 1 });
    expect(await second.json()).toEqual({ n: 1 });
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(calls).toBe(1);
  });

  it("same key with a different body is idempotency_key_reuse", async () => {
    const { app, pk } = await setup();
    await app.fetch(post({ message: "a" }, "k", undefined, pk));
    const res = await app.fetch(post({ message: "b" }, "k", undefined, pk));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "idempotency_key_reuse" });
  });

  it("does not store 5xx responses", async () => {
    const { app, pk } = await setup();
    let fail = true;
    app.post("/store/flaky", (c) => {
      if (fail) throw new Error("x");
      return c.json({ ok: true });
    });
    expect((await app.fetch(post({}, "k", "/store/flaky", pk))).status).toBe(
      500,
    );
    fail = false;
    expect((await app.fetch(post({}, "k", "/store/flaky", pk))).status).toBe(
      200,
    );
  });
});

describe("rate limit", () => {
  it("returns rate_limited with Retry-After past the limit, then resets", async () => {
    let t = 0;
    const { app, sk } = await setup({
      rateLimit: memoryRateLimitStore(() => t),
      rateLimitOptions: { limit: 2, windowMs: 60_000 },
      now: () => t,
    });
    const get = () =>
      app.request("/admin/ping", {
        headers: { ...sk, "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
      });
    await get();
    await get();
    t = 10_000;
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("50");
    expect(await res.json()).toMatchObject({ code: "rate_limited" });
    t = 60_000;
    expect((await get()).status).toBe(200);
  });
});

import {
  createEventBus,
  createWebhookEndpoint,
  type DomainEvent,
  decryptSecret,
  deliverDueWebhooks,
  fanOutWebhooks,
  getWebhookEndpoint,
  relayOutbox,
  replayWebhookDelivery,
  updateWebhookEndpoint,
  verifyWebhook,
  WEBHOOK_BACKOFF_SECONDS,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookError,
} from "@free-commerce/core";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "./index";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const evt = (id: string, type = "order.created"): DomainEvent => ({
  id,
  type,
  occurredAt: "2026-03-01T00:00:00.000Z",
  payload: { orderId: "ord_1", email: "pii@example.com" },
});

type Call = { url: string; init: RequestInit };
const world = async (
  respond: (call: Call, n: number) => Response | Promise<Response>,
  events = ["*"],
  over: { url?: string; resolve?: (h: string) => Promise<string[]> } = {},
) => {
  const db = createMemoryDatabase();
  let now = T0;
  const calls: Call[] = [];
  const { endpoint, secret } = await createWebhookEndpoint(
    db,
    { url: over.url ?? "https://hooks.example.com/in", events },
    { key: KEY, now },
  );
  const deps = {
    db,
    key: KEY,
    now: () => now,
    resolve: over.resolve,
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return respond(call, calls.length);
    }) as unknown as typeof fetch,
  };
  return {
    db,
    endpoint,
    secret,
    calls,
    deps,
    advance: (s: number) => {
      now += s * 1000;
    },
    tick: () => deliverDueWebhooks(deps),
    now: () => now,
  };
};
const status = (code: number) => new Response(null, { status: code });
const deliveries = async (w: Awaited<ReturnType<typeof world>>) =>
  (await w.db.webhookDeliveries.listFor(w.endpoint.id, { limit: 50 })).items;

describe("endpoints", () => {
  it("shows the secret once, stores it encrypted and rejects unsafe URLs", async () => {
    const w = await world(() => status(200));
    expect(w.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    const stored = await w.db.webhookEndpoints.get(w.endpoint.id);
    expect(JSON.stringify(stored)).not.toContain(w.secret);
    expect(await decryptSecret(KEY, stored?.secretCipher ?? "")).toBe(w.secret);
    await expect(
      createWebhookEndpoint(
        w.db,
        { url: "https://10.0.0.5/x", events: ["*"] },
        { key: KEY, now: T0 },
      ),
    ).rejects.toThrow("rejected");
    await expect(
      createWebhookEndpoint(
        w.db,
        { url: "https://a.example.com", events: [] },
        { key: KEY, now: T0 },
      ),
    ).rejects.toThrow("events");
    await expect(
      updateWebhookEndpoint(w.db, w.endpoint.id, {
        url: "http://a.example.com",
      }),
    ).rejects.toThrow("rejected");
    await expect(getWebhookEndpoint(w.db, "whk_missing")).rejects.toMatchObject(
      {
        code: "not_found",
      } satisfies Partial<WebhookError>,
    );
  });
});

describe("fan-out", () => {
  it("creates one delivery per matching enabled endpoint and is idempotent", async () => {
    const w = await world(() => status(200), ["order.created"]);
    await createWebhookEndpoint(
      w.db,
      { url: "https://b.example.com/", events: ["refund.created"] },
      { key: KEY, now: T0 },
    );
    const off = await createWebhookEndpoint(
      w.db,
      { url: "https://c.example.com/", events: ["*"] },
      { key: KEY, now: T0 },
    );
    await updateWebhookEndpoint(w.db, off.endpoint.id, { enabled: false });
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    const list = await deliveries(w);
    expect(list.map((d) => d.endpointId)).toEqual([w.endpoint.id]);
    expect(
      (await w.db.webhookDeliveries.list({ limit: 10 })).items,
    ).toHaveLength(1);
  });

  it("is driven by the outbox through the bus wildcard", async () => {
    const w = await world(() => status(200));
    const bus = createEventBus();
    bus.subscribe("*", (e) => fanOutWebhooks(w.db, e, w.now()));
    await w.db.outbox.add(evt("evt_1"));
    await w.db.outbox.add(evt("evt_2", "refund.created"));
    expect(await relayOutbox(w.db.outbox, bus)).toBe(2);
    expect(await deliveries(w)).toHaveLength(2);
  });
});

describe("delivery", () => {
  it("posts a signed body with the event id that a receiver can verify", async () => {
    const w = await world(() => status(204));
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    expect(await w.tick()).toBe(1);
    const { url, init } = w.calls[0] as Call;
    expect(url).toBe("https://hooks.example.com/in");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = init.headers as Record<string, string>;
    expect(h["webhook-id"]).toBe("evt_1");
    expect(
      await verifyWebhook({
        secret: w.secret,
        id: h["webhook-id"] as string,
        timestamp: h["webhook-timestamp"] as string,
        signature: h["webhook-signature"] as string,
        body: init.body as string,
        now: w.now() / 1000,
      }),
    ).toBe(true);
    expect(JSON.parse(init.body as string)).toMatchObject({
      id: "evt_1",
      type: "order.created",
    });
    const [d] = await deliveries(w);
    expect(d).toMatchObject({
      status: "succeeded",
      attempts: 1,
      lastStatus: 204,
      nextAttemptAt: null,
    });
    expect(await w.tick()).toBe(0);
  });

  it("retries 5xx with backoff, then exhausts and disables the endpoint with a reason", async () => {
    const w = await world(() => status(503));
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      expect(await w.tick()).toBe(1);
      const [d] = await deliveries(w);
      const wait = WEBHOOK_BACKOFF_SECONDS[attempt - 1] as number;
      expect(d).toMatchObject({
        status: "pending",
        attempts: attempt,
        lastStatus: 503,
        lastError: "HTTP 503",
      });
      expect(d?.nextAttemptAt).toBe(
        new Date(w.now() + wait * 1000).toISOString(),
      );
      w.advance(wait - 1);
      expect(await w.tick()).toBe(0); // not due yet
      w.advance(1);
    }
    expect(await w.tick()).toBe(1);
    const [d] = await deliveries(w);
    expect(d).toMatchObject({
      status: "failed",
      attempts: WEBHOOK_MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
    const e = await getWebhookEndpoint(w.db, w.endpoint.id);
    expect(e.enabled).toBe(false);
    expect(e.disabledReason).toContain("failed 6 times");
    expect(e.disabledReason).toContain("HTTP 503");
    expect(w.calls).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    // A later event is no longer fanned out to the disabled endpoint.
    await fanOutWebhooks(w.db, evt("evt_2"), w.now());
    expect(await deliveries(w)).toHaveLength(1);
  });

  it("treats a timeout and a network error as retryable failures without leaking details", async () => {
    const w = await world((_c, n) => {
      throw n === 1
        ? new DOMException("secret internal detail", "TimeoutError")
        : new Error("connect ECONNREFUSED 10.0.0.9");
    });
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await w.tick();
    expect((await deliveries(w))[0]).toMatchObject({
      status: "pending",
      lastStatus: null,
      lastError: "timeout",
    });
    w.advance(60);
    await w.tick();
    expect((await deliveries(w))[0]?.lastError).toBe("network error");
  });

  it("does not follow redirects: a 3xx is a failure", async () => {
    const w = await world(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        }),
    );
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await w.tick();
    expect(w.calls).toHaveLength(1);
    expect((await deliveries(w))[0]).toMatchObject({
      status: "pending",
      lastStatus: 302,
    });
  });

  it("refuses a URL that resolves to a private address and one that no longer passes the guard", async () => {
    const w = await world(() => status(200), ["*"], {
      resolve: async () => ["93.184.216.34", "10.0.0.7"],
    });
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await w.tick();
    expect(w.calls).toHaveLength(0);
    expect((await deliveries(w))[0]?.lastError).toBe(
      "blocked: host resolves to a private address",
    );
    const ok = await world(() => status(200), ["*"], {
      resolve: async () => ["93.184.216.34"],
    });
    await fanOutWebhooks(ok.db, evt("evt_1"), ok.now());
    await ok.tick();
    expect(ok.calls).toHaveLength(1);
  });

  it("never logs or stores secrets, payloads or response bodies in the delivery record", async () => {
    const w = await world(
      () => new Response("body with pii@example.com", { status: 500 }),
    );
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await w.tick();
    const d = (await deliveries(w))[0];
    expect(d?.lastError).toBe("HTTP 500");
    expect(JSON.stringify({ ...d, event: undefined })).not.toMatch(
      /pii@|whsec_/,
    );
  });

  it("holds deliveries of a disabled endpoint and resumes them once it is re-enabled", async () => {
    const w = await world(() => status(200));
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await updateWebhookEndpoint(w.db, w.endpoint.id, { enabled: false });
    await w.tick();
    expect(w.calls).toHaveLength(0);
    expect((await deliveries(w))[0]).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    await updateWebhookEndpoint(w.db, w.endpoint.id, { enabled: true });
    w.advance(3600);
    await w.tick();
    expect((await deliveries(w))[0]?.status).toBe("succeeded");
  });

  it("re-checks the URL before every send, whatever is stored", async () => {
    const w = await world(() => status(200));
    await w.db.webhookEndpoints.save({
      ...w.endpoint,
      url: "https://10.0.0.1/x",
    });
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await w.tick();
    expect(w.calls).toHaveLength(0);
    expect((await deliveries(w))[0]?.lastError).toBe(
      "blocked: host is a private or reserved address",
    );
  });

  it("does not turn a 2xx into a retry when closing the response body fails", async () => {
    const w = await world(
      () =>
        ({
          status: 200,
          body: {
            cancel: async () => {
              throw new Error("stream");
            },
          },
        }) as unknown as Response,
    );
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await w.tick();
    expect((await deliveries(w))[0]).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
  });

  it("keeps an admin replay made while an attempt is in flight", async () => {
    let id = "";
    const w = await world(async () => {
      await replayWebhookDelivery(w.db, id, w.now());
      return status(500);
    });
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    id = (await deliveries(w))[0]?.id ?? "";
    await w.tick();
    expect((await deliveries(w))[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
  });

  it("claims a delivery before sending so another worker leaves it alone", async () => {
    const w = await world(async () => {
      expect(await w.tick()).toBe(0);
      return status(200);
    });
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await w.tick();
    expect(w.calls).toHaveLength(1);
  });
});

describe("replay", () => {
  it("re-sends a delivery with the same event id and a fresh attempt budget", async () => {
    let healthy = false;
    const w = await world(() => status(healthy ? 200 : 500));
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      await w.tick();
      w.advance(86_400);
    }
    const failed = (await deliveries(w))[0];
    expect(failed?.status).toBe("failed");
    await expect(
      replayWebhookDelivery(w.db, failed?.id ?? "", w.now()),
    ).rejects.toThrow("Enable");
    await updateWebhookEndpoint(w.db, w.endpoint.id, { enabled: true });
    expect(
      (await getWebhookEndpoint(w.db, w.endpoint.id)).disabledReason,
    ).toBeNull();
    healthy = true;
    await replayWebhookDelivery(w.db, failed?.id ?? "", w.now());
    await w.tick();
    const done = (await deliveries(w))[0];
    expect(done).toMatchObject({ status: "succeeded", attempts: 1 });
    const ids = w.calls.map(
      (c) => (c.init.headers as Record<string, string>)["webhook-id"],
    );
    expect(new Set(ids)).toEqual(new Set(["evt_1"]));
    await expect(
      replayWebhookDelivery(w.db, "whd_missing", w.now()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("can replay a delivery that already succeeded", async () => {
    const w = await world(() => status(200));
    await fanOutWebhooks(w.db, evt("evt_1"), w.now());
    await w.tick();
    const [d] = await deliveries(w);
    await replayWebhookDelivery(w.db, d?.id ?? "", w.now());
    await w.tick();
    expect(w.calls).toHaveLength(2);
  });
});

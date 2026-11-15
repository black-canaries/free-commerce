import { ProviderError, paymentEventSchema } from "@free-commerce/core";
import { paymentConformance } from "@free-commerce/core/testing";
import { describe, expect, it } from "vitest";
import { fakeStripe, SECRET, signed, WHSEC } from "./fake-stripe";
import { createStripePayments } from "./stripe";

const T = 1_700_000_000;
const usd = (amount: number) => ({ amount, currency: "USD" });
const make = (fetch?: (r: Request) => Promise<Response>) => {
  const fake = fakeStripe();
  const provider = createStripePayments({
    secretKey: SECRET,
    webhookSecret: WHSEC,
    fetch: fetch ?? fake.fetch,
    now: () => T * 1000,
  });
  return { fake, provider };
};
const intentEvent = (type: string, object: object, id = "evt_1") =>
  JSON.stringify({ id, type, data: { object } });
const obj = {
  id: "pi_1",
  status: "succeeded",
  amount: 1000,
  amount_received: 1000,
  currency: "usd",
};

paymentConformance("stripe (mocked HTTP)", () => {
  const { provider } = make();
  const hook = (id: string) => {
    const rawBody = intentEvent("payment_intent.succeeded", { ...obj, id });
    return { rawBody, headers: signed(rawBody, T) };
  };
  return {
    provider,
    okToken: "pm_ok",
    webhook: hook,
    sign: (b) => signed(b, T),
    signWrong: (b) => signed(b, T, "whsec_wrong"),
  };
});

describe("stripe mapping", () => {
  it("decline is a failed payment with the decline code", async () => {
    const { provider } = make();
    const p = await provider.createPayment({
      idempotencyKey: "a",
      amount: usd(500),
      reference: "o",
    });
    expect(
      await provider.confirm({
        idempotencyKey: "b",
        paymentId: p.id,
        methodToken: "pm_decline",
      }),
    ).toMatchObject({
      state: "failed",
      failureCode: "insufficient_funds",
    });
  });

  it("3DS surfaces a redirect action; async methods stay pending", async () => {
    const { provider } = make();
    const a = await provider.createPayment({
      idempotencyKey: "a",
      amount: usd(500),
      reference: "o",
    });
    expect(
      await provider.confirm({
        idempotencyKey: "b",
        paymentId: a.id,
        methodToken: "pm_3ds",
      }),
    ).toMatchObject({
      state: "requires_action",
      action: { type: "redirect", url: "https://hooks.stripe.test/3ds" },
    });
    const c = await provider.createPayment({
      idempotencyKey: "c",
      amount: usd(500),
      reference: "o",
    });
    expect(
      (
        await provider.confirm({
          idempotencyKey: "d",
          paymentId: c.id,
          methodToken: "pm_async",
        })
      ).state,
    ).toBe("pending");
  });

  it("new payments hand back a client secret; PAN-shaped tokens are refused locally", async () => {
    const { provider, fake } = make();
    const p = await provider.createPayment({
      idempotencyKey: "a",
      amount: usd(500),
      reference: "o",
    });
    expect(p.action).toMatchObject({
      type: "client",
      clientSecret: expect.any(String),
    });
    const before = fake.requests.length;
    await expect(
      provider.confirm({
        idempotencyKey: "b",
        paymentId: p.id,
        methodToken: "4242424242424242",
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(fake.requests.length).toBe(before);
  });

  it("sends auth, idempotency key and pinned version; secret stays out of errors", async () => {
    const { provider, fake } = make();
    await provider.createPayment({
      idempotencyKey: "key-1",
      amount: usd(500),
      reference: "o",
    });
    const r = fake.requests[0] as Request;
    expect(r.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(r.headers.get("idempotency-key")).toBe("key-1");
    expect(r.headers.get("stripe-version")).toBeTruthy();
    const e = (await provider
      .retrieve("pi_nope")
      .catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain(SECRET);
  });

  it("maps outages, rate limits and network failures to retryable unavailable", async () => {
    for (const f of [
      async () => new Response("{}", { status: 503 }),
      async () => new Response("{}", { status: 429 }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      const e = await make(f)
        .provider.retrieve("pi_1")
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).retryable).toBe(true);
    }
  });

  it("off-session charge needing authentication returns requires_action", async () => {
    const { provider } = make(async (r) =>
      r.url.includes("payment_methods")
        ? new Response(JSON.stringify({ customer: "cus_1" }))
        : new Response(
            JSON.stringify({
              error: {
                message: "auth",
                payment_intent: {
                  id: "pi_9",
                  status: "requires_payment_method",
                  amount: 200,
                  currency: "usd",
                  client_secret: "pi_9_secret",
                  last_payment_error: { code: "authentication_required" },
                },
              },
            }),
            { status: 402 },
          ),
    );
    const p = await provider.chargeSavedMethod({
      idempotencyKey: "k",
      savedMethodId: "pm_1",
      customerRef: "cus_1",
      amount: usd(200),
      reference: "o",
    });
    expect(p).toMatchObject({
      state: "requires_action",
      action: { type: "client" },
    });
  });
});

describe("stripe webhooks", () => {
  const verify = (
    body: string,
    headers: Record<string, string | undefined>,
    fetch?: (r: Request) => Promise<Response>,
  ) => make(fetch).provider.verifyWebhook(body, headers);

  it("maps a payment_intent event, keeps the Stripe event id, drops the client secret", async () => {
    const body = intentEvent(
      "payment_intent.created",
      {
        ...obj,
        status: "requires_payment_method",
        client_secret: "pi_1_secret",
      },
      "evt_42",
    );
    const ev = await verify(body, signed(body, T));
    expect(paymentEventSchema.parse(ev)).toMatchObject({
      id: "evt_42",
      payment: { state: "requires_action" },
    });
    expect(ev.payment.action).toBeUndefined();
  });

  it("maps payment_failed to failed", async () => {
    const body = intentEvent("payment_intent.payment_failed", {
      ...obj,
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined" },
    });
    expect((await verify(body, signed(body, T))).payment).toMatchObject({
      state: "failed",
      failureCode: "card_declined",
    });
  });

  it("refund events carry the refund plus the fetched payment", async () => {
    const body = intentEvent("refund.updated", {
      id: "re_1",
      amount: 400,
      currency: "usd",
      status: "failed",
      payment_intent: "pi_1",
    });
    const ev = await verify(
      body,
      signed(body, T),
      async () => new Response(JSON.stringify(obj)),
    );
    expect(ev).toMatchObject({
      payment: { id: "pi_1", state: "captured" },
      refund: { id: "re_1", state: "failed", amount: usd(400) },
    });
  });

  it("rejects stale timestamps, tampered bodies and unsupported event types", async () => {
    const body = intentEvent("payment_intent.succeeded", obj);
    const bad = (b: string, h: Record<string, string | undefined>) =>
      expect(verify(b, h)).rejects.toMatchObject({ code: "rejected" });
    await bad(body, signed(body, T - 301));
    await bad(`${body} `, signed(body, T));
    const other = intentEvent("customer.created", { id: "cus_1" });
    await bad(other, signed(other, T));
    await bad(body, { "stripe-signature": "t=x,v1=zz" });
  });

  it("accepts any matching v1 among several (secret rotation)", async () => {
    const body = intentEvent("payment_intent.succeeded", obj);
    const h = `${signed(body, T, "whsec_old")["stripe-signature"]},${signed(body, T)["stripe-signature"].split(",")[1]}`;
    expect((await verify(body, { "stripe-signature": h })).payment.state).toBe(
      "captured",
    );
  });
});

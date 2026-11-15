import type { PaymentProvider } from "@free-commerce/core";
import { paymentConformance } from "@free-commerce/core/testing";
import { describe, it } from "vitest";
import { signed } from "./fake-stripe";
import { createStripePayments } from "./stripe";

/** Live conformance against Stripe test mode. Skipped unless `STRIPE_TEST_KEY` (sk_test_/rk_test_) is set. */
const key = process.env.STRIPE_TEST_KEY;
const WHSEC = "whsec_live_suite";

if (!key)
  describe.skip("stripe live (STRIPE_TEST_KEY unset)", () =>
    it("skipped", () => {}));
else if (!/^[sr]k_test_/.test(key))
  throw new Error("STRIPE_TEST_KEY must be a test-mode key");
else {
  const inner = createStripePayments({ secretKey: key, webhookSecret: WHSEC });
  // Conformance reuses fixed keys and customer names; Stripe would replay old results and has no cus_1.
  const live = (): PaymentProvider => {
    const run = crypto.randomUUID();
    const customers = new Map<string, Promise<string>>();
    const cus = (ref?: string) => {
      if (!ref) return undefined;
      let c = customers.get(ref);
      if (!c) {
        c = fetch("https://api.stripe.com/v1/customers", {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
        })
          .then((r) => r.json() as Promise<{ id: string }>)
          .then((j) => j.id);
        customers.set(ref, c);
      }
      return c;
    };
    const k = (i: { idempotencyKey: string }) => `${run}-${i.idempotencyKey}`;
    return {
      ...inner,
      createPayment: async (i) =>
        inner.createPayment({
          ...i,
          idempotencyKey: k(i),
          customerRef: await cus(i.customerRef),
        }),
      confirm: (i) => inner.confirm({ ...i, idempotencyKey: k(i) }),
      capture: (i) => inner.capture({ ...i, idempotencyKey: k(i) }),
      refund: (i) => inner.refund({ ...i, idempotencyKey: k(i) }),
      chargeSavedMethod: async (i) =>
        inner.chargeSavedMethod({
          ...i,
          idempotencyKey: k(i),
          customerRef: (await cus(i.customerRef)) as string,
        }),
    };
  };
  paymentConformance("stripe (live test mode)", () => {
    const t = Math.floor(Date.now() / 1000);
    return {
      provider: live(),
      okToken: "pm_card_visa",
      webhook: (id) => {
        const rawBody = JSON.stringify({
          id: "evt_live",
          type: "payment_intent.succeeded",
          data: {
            object: { id, status: "succeeded", amount: 1000, currency: "usd" },
          },
        });
        return { rawBody, headers: signed(rawBody, t) };
      },
      sign: (b) => signed(b, t),
      signWrong: (b) => signed(b, t, "whsec_wrong"),
    };
  });
}

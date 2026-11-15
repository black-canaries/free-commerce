import { describe, expect, it } from "vitest";
import type { ProviderError } from "./error";
import type { PaymentProvider } from "./payment";

const usd = (amount: number) => ({ amount, currency: "USD" });
const code = async (p: Promise<unknown>) =>
  ((await p.catch((e: unknown) => e)) as ProviderError).code;

/**
 * @experimental Every card-style `PaymentProvider` (fake or real, test mode) must pass this.
 * `okToken` is a method token that succeeds immediately; `webhook()` returns a signed
 * delivery for any payment id the provider knows. Manual providers are exempt (stateless).
 */
export function paymentConformance(
  name: string,
  make: () => {
    provider: PaymentProvider;
    okToken: string;
    webhook: (paymentId: string) => {
      rawBody: string;
      headers: Record<string, string>;
    };
    /** Valid signature for an arbitrary body. */
    sign: (rawBody: string) => Record<string, string>;
    /** Signature made with the wrong secret. */
    signWrong: (rawBody: string) => Record<string, string>;
  },
): void {
  describe(`PaymentProvider conformance: ${name}`, () => {
    const pay = async (captureMode: "automatic" | "manual" = "automatic") => {
      const t = make();
      const created = await t.provider.createPayment({
        idempotencyKey: "c1",
        amount: usd(1000),
        reference: "ord_1",
        captureMode,
      });
      const done = await t.provider.confirm({
        idempotencyKey: "f1",
        paymentId: created.id,
        methodToken: t.okToken,
      });
      return { ...t, created, done };
    };

    it("starts in requires_action and never carries card data", async () => {
      const t = make();
      const p = await t.provider.createPayment({
        idempotencyKey: "k",
        amount: usd(500),
        reference: "ord_1",
      });
      expect(p.state).toBe("requires_action");
      expect(p.amount).toEqual(usd(500));
    });

    it("rejects non-positive or fractional amounts", async () => {
      const { provider } = make();
      for (const amount of [0, -1, 1.5]) {
        expect(
          await code(
            provider.createPayment({
              idempotencyKey: `k${amount}`,
              amount: usd(amount),
              reference: "r",
            }),
          ),
        ).toBe("rejected");
      }
    });

    it("replays the same idempotency key and rejects a changed input", async () => {
      const { provider } = make();
      const input = {
        idempotencyKey: "same",
        amount: usd(500),
        reference: "ord_1",
      };
      const a = await provider.createPayment(input);
      expect(await provider.createPayment(input)).toEqual(a);
      expect(
        await code(provider.createPayment({ ...input, amount: usd(600) })),
      ).toBe("rejected");
    });

    it("captures automatically and refunds up to the captured amount", async () => {
      const { provider, created, done } = await pay();
      expect(done.state).toBe("captured");
      const r = await provider.refund({
        idempotencyKey: "r1",
        paymentId: created.id,
        amount: usd(400),
      });
      expect(r.amount).toEqual(usd(400));
      expect(
        await code(
          provider.refund({
            idempotencyKey: "r2",
            paymentId: created.id,
            amount: usd(700),
          }),
        ),
      ).toBe("rejected");
      await provider.refund({
        idempotencyKey: "r3",
        paymentId: created.id,
        amount: usd(600),
      });
    });

    it("manual capture authorizes first; capture takes at most the authorization", async () => {
      const { provider, created, done } = await pay("manual");
      expect(done.state).toBe("authorized");
      expect(
        await code(
          provider.capture({
            idempotencyKey: "x",
            paymentId: created.id,
            amount: usd(1001),
          }),
        ),
      ).toBe("rejected");
      const c = await provider.capture({
        idempotencyKey: "c2",
        paymentId: created.id,
        amount: usd(900),
      });
      expect(c).toMatchObject({ state: "captured", amount: usd(900) });
    });

    it("cannot refund or capture an uncaptured payment", async () => {
      const { provider, created } = await pay("manual");
      expect(
        await code(
          provider.refund({
            idempotencyKey: "r",
            paymentId: created.id,
            amount: usd(1),
          }),
        ),
      ).toBe("rejected");
    });

    it("retrieve returns the current state; unknown ids are not_found", async () => {
      const { provider, created, done } = await pay();
      expect(await provider.retrieve(created.id)).toEqual(done);
      expect(await code(provider.retrieve("nope"))).toBe("not_found");
    });

    it("saved methods: chargeSavedMethod needs the owning customer", async () => {
      const t = make();
      const p = await t.provider.createPayment({
        idempotencyKey: "s",
        amount: usd(500),
        reference: "ord_1",
        saveMethod: true,
        customerRef: "cus_1",
      });
      const done = await t.provider.confirm({
        idempotencyKey: "s2",
        paymentId: p.id,
        methodToken: t.okToken,
      });
      expect(done.savedMethodId).toEqual(expect.any(String));
      const charge = (customerRef: string) =>
        t.provider.chargeSavedMethod({
          idempotencyKey: `u-${customerRef}`,
          savedMethodId: done.savedMethodId as string,
          customerRef,
          amount: usd(200),
          reference: "ord_2",
        });
      expect((await charge("cus_1")).state).toBe("captured");
      expect(await code(charge("cus_2"))).toBe("not_found");
    });

    it("rejects bad money guards and currency mismatches", async () => {
      const { provider, created } = await pay("manual");
      const eur = { amount: 100, currency: "EUR" };
      for (const amount of [usd(0), usd(-1), eur]) {
        expect(
          await code(
            provider.capture({
              idempotencyKey: `c${amount.amount}${amount.currency}`,
              paymentId: created.id,
              amount,
            }),
          ),
        ).toBe("rejected");
      }
      await provider.capture({
        idempotencyKey: "ok",
        paymentId: created.id,
        amount: usd(1000),
      });
      expect(
        await code(
          provider.refund({
            idempotencyKey: "eur",
            paymentId: created.id,
            amount: eur,
          }),
        ),
      ).toBe("rejected");
    });

    it("saveMethod requires a customerRef; saved charges need a positive amount", async () => {
      const t = make();
      expect(
        await code(
          t.provider.createPayment({
            idempotencyKey: "nc",
            amount: usd(5),
            reference: "r",
            saveMethod: true,
          }),
        ),
      ).toBe("rejected");
      const p = await t.provider.createPayment({
        idempotencyKey: "sm",
        amount: usd(5),
        reference: "r",
        saveMethod: true,
        customerRef: "cus_1",
      });
      const { savedMethodId } = await t.provider.confirm({
        idempotencyKey: "sm2",
        paymentId: p.id,
        methodToken: t.okToken,
      });
      for (const amount of [0, -1]) {
        expect(
          await code(
            t.provider.chargeSavedMethod({
              idempotencyKey: `z${amount}`,
              savedMethodId: savedMethodId as string,
              customerRef: "cus_1",
              amount: usd(amount),
              reference: "r",
            }),
          ),
        ).toBe("rejected");
      }
    });

    it("verifies webhook signatures over the raw body", async () => {
      const { provider, created, webhook, sign, signWrong } = await pay();
      const d = webhook(created.id);
      const event = await provider.verifyWebhook(d.rawBody, d.headers);
      expect(event.payment.id).toBe(created.id);
      expect(event.id).toEqual(expect.any(String));
      expect(
        await code(provider.verifyWebhook(`${d.rawBody} `, d.headers)),
      ).toBe("rejected");
      expect(await code(provider.verifyWebhook(d.rawBody, {}))).toBe(
        "rejected",
      );
      expect(
        await code(provider.verifyWebhook(d.rawBody, signWrong(d.rawBody))),
      ).toBe("rejected");
      // validly signed but not a PaymentEvent: must be rejected, never cast
      expect(await code(provider.verifyWebhook("{}", sign("{}")))).toBe(
        "rejected",
      );
    });
  });
}

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PAYMENT_STATE_TRANSITIONS,
  type PaymentProvider,
  type PaymentState,
} from "./payment";
import { paymentConformance } from "./payment.conformance";
import { createFakePayments, FAKE_TOKENS } from "./payment.fake";
import { createManualPayments } from "./payment.manual";

const usd = (amount: number) => ({ amount, currency: "USD" });

paymentConformance("fake", () => {
  const fake = createFakePayments();
  return {
    provider: fake,
    okToken: FAKE_TOKENS.ok,
    webhook: (id) => fake.delivery(id),
    sign: fake.sign,
    signWrong: fake.signWrong,
  };
});

const start = async (token: string, captureMode?: "manual") => {
  const fake = createFakePayments();
  const p = await fake.createPayment({
    idempotencyKey: "c",
    amount: usd(1000),
    reference: "ord_1",
    captureMode,
  });
  const confirmed = await fake.confirm({
    idempotencyKey: "f",
    paymentId: p.id,
    methodToken: token,
  });
  return { fake, id: p.id, confirmed };
};

describe("fake payments: every state and failure mode", () => {
  it("3DS: requires_action with redirect, then captured or failed", async () => {
    const { fake, id, confirmed } = await start(FAKE_TOKENS.threeDs);
    expect(confirmed).toMatchObject({
      state: "requires_action",
      action: { type: "redirect" },
    });
    expect(fake.resolve(id, "success")).toMatchObject({ state: "captured" });
    const f = await start(FAKE_TOKENS.threeDs);
    expect(f.fake.resolve(f.id, "failure")).toMatchObject({
      state: "failed",
      failureCode: "authentication_failed",
    });
  });

  it("async methods stay pending until settled", async () => {
    const { fake, id, confirmed } = await start(FAKE_TOKENS.async);
    expect(confirmed.state).toBe("pending");
    expect(fake.resolve(id, "success").state).toBe("captured");
    expect(() => fake.resolve(id, "success")).toThrow(/nothing to resolve/);
  });

  it("decline is a failed payment, not an error; failed is terminal", async () => {
    const { fake, id, confirmed } = await start(FAKE_TOKENS.declined);
    expect(confirmed).toMatchObject({
      state: "failed",
      failureCode: "card_declined",
    });
    await expect(
      fake.confirm({
        idempotencyKey: "again",
        paymentId: id,
        methodToken: FAKE_TOKENS.ok,
      }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("outage is retryable and leaves the payment confirmable", async () => {
    const fake = createFakePayments();
    const p = await fake.createPayment({
      idempotencyKey: "n",
      amount: usd(5),
      reference: "r",
    });
    const err = await fake
      .confirm({
        idempotencyKey: "d",
        paymentId: p.id,
        methodToken: FAKE_TOKENS.unavailable,
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable", retryable: true });
    expect((await fake.retrieve(p.id)).state).toBe("requires_action");
  });

  it("unknown tokens are rejected (no raw card data accepted)", async () => {
    const fake = createFakePayments();
    const p = await fake.createPayment({
      idempotencyKey: "n",
      amount: usd(5),
      reference: "r",
    });
    await expect(
      fake.confirm({
        idempotencyKey: "x",
        paymentId: p.id,
        methodToken: "4242424242424242",
      }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("off-session saved charges can need authentication or be declined", async () => {
    for (const [token, state] of [
      [FAKE_TOKENS.threeDs, "requires_action"],
      [FAKE_TOKENS.declineLater, "failed"],
    ] as const) {
      const fake = createFakePayments();
      const p = await fake.createPayment({
        idempotencyKey: "n",
        amount: usd(5),
        reference: "r",
        saveMethod: true,
        customerRef: "cus_1",
      });
      let saved = (
        await fake.confirm({
          idempotencyKey: "x",
          paymentId: p.id,
          methodToken: token,
        })
      ).savedMethodId;
      if (!saved) saved = fake.resolve(p.id, "success").savedMethodId;
      const charge = await fake.chargeSavedMethod({
        idempotencyKey: "u",
        savedMethodId: saved as string,
        customerRef: "cus_1",
        amount: usd(5),
        reference: "r2",
      });
      expect(charge.state).toBe(state);
    }
  });

  it("webhook from another secret is rejected", async () => {
    const a = createFakePayments("one");
    const b = createFakePayments("two");
    const p = await a.createPayment({
      idempotencyKey: "n",
      amount: usd(5),
      reference: "r",
    });
    const d = a.delivery(p.id);
    await expect(b.verifyWebhook(d.rawBody, d.headers)).rejects.toMatchObject({
      code: "rejected",
    });
  });
});

describe("refund outcomes", () => {
  it("pending and failed refunds; a failed refund frees the amount", async () => {
    const { fake, id } = await start(FAKE_TOKENS.ok);
    const refund = (k: string, amount: number) =>
      fake.refund({ idempotencyKey: k, paymentId: id, amount: usd(amount) });
    fake.refundsAs("pending");
    expect((await refund("a", 1000)).state).toBe("pending");
    fake.refundsAs("failed");
    await expect(refund("b", 1)).rejects.toMatchObject({ code: "rejected" });
    fake.refundsAs("succeeded");
    const fresh = await start(FAKE_TOKENS.ok);
    fresh.fake.refundsAs("failed");
    const f = (k: string) =>
      fresh.fake.refund({
        idempotencyKey: k,
        paymentId: fresh.id,
        amount: usd(1000),
      });
    expect((await f("x")).state).toBe("failed");
    expect((await f("y")).state).toBe("failed");
  });
});

describe("state transitions (property)", () => {
  type Cmd =
    | { t: "confirm"; token: string }
    | { t: "resolve"; ok: boolean }
    | { t: "capture"; amount: number }
    | { t: "refund"; amount: number };
  const cmd = fc.oneof(
    fc.record({
      t: fc.constant("confirm" as const),
      token: fc.constantFrom(...Object.values(FAKE_TOKENS), "bogus"),
    }),
    fc.record({ t: fc.constant("resolve" as const), ok: fc.boolean() }),
    fc.record({
      t: fc.constant("capture" as const),
      amount: fc.integer({ min: -5, max: 1200 }),
    }),
    fc.record({
      t: fc.constant("refund" as const),
      amount: fc.integer({ min: -5, max: 1200 }),
    }),
  );

  const forward = (from: PaymentState, to: PaymentState) =>
    from === to || PAYMENT_STATE_TRANSITIONS[from].includes(to);

  const apply = async (
    fake: ReturnType<typeof createFakePayments>,
    paymentId: string,
    c: Cmd,
    idempotencyKey: string,
  ): Promise<number> => {
    try {
      if (c.t === "confirm")
        await fake.confirm({ idempotencyKey, paymentId, methodToken: c.token });
      else if (c.t === "resolve")
        fake.resolve(paymentId, c.ok ? "success" : "failure");
      else if (c.t === "capture")
        await fake.capture({
          idempotencyKey,
          paymentId,
          amount: usd(c.amount),
        });
      else {
        await fake.refund({ idempotencyKey, paymentId, amount: usd(c.amount) });
        return c.amount;
      }
    } catch {
      // rejected commands must not change state; checked by the caller
    }
    return 0;
  };

  it("only forward moves; refunds never exceed capture; amount never grows", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(cmd as fc.Arbitrary<Cmd>, { maxLength: 12 }),
        async (manual, cmds) => {
          const fake = createFakePayments();
          const p = await fake.createPayment({
            idempotencyKey: "c",
            amount: usd(1000),
            reference: "r",
            captureMode: manual ? "manual" : "automatic",
          });
          let prev = p.state;
          let refunded = 0;
          for (const [n, c] of cmds.entries()) {
            refunded += await apply(fake, p.id, c, `k${n}`);
            const now = await fake.retrieve(p.id);
            expect(forward(prev, now.state)).toBe(true);
            expect(now.amount.amount).toBeLessThanOrEqual(1000);
            expect(refunded).toBeLessThanOrEqual(
              now.state === "captured" ? now.amount.amount : 0,
            );
            prev = now.state;
          }
        },
      ),
    );
  });

  it("terminal states have no exits", () => {
    expect(PAYMENT_STATE_TRANSITIONS.captured).toEqual([]);
    expect(PAYMENT_STATE_TRANSITIONS.failed).toEqual([]);
  });
});

describe("manual payments", () => {
  const m: PaymentProvider = createManualPayments();

  it("pending until an admin captures; replays derive the same ids", async () => {
    const i = { idempotencyKey: "k", amount: usd(900), reference: "ord_1" };
    const p = await m.createPayment(i);
    expect(p).toEqual(await m.createPayment(i));
    expect(p.state).toBe("pending");
    expect(
      await m.capture({
        idempotencyKey: "c",
        paymentId: p.id,
        amount: usd(900),
      }),
    ).toMatchObject({ id: p.id, state: "captured" });
    expect(
      (
        await m.refund({
          idempotencyKey: "r",
          paymentId: p.id,
          amount: usd(100),
        })
      ).state,
    ).toBe("succeeded");
  });

  it("refuses card-only operations and bad amounts", async () => {
    await expect(
      m.createPayment({ idempotencyKey: "k", amount: usd(0), reference: "r" }),
    ).rejects.toMatchObject({ code: "rejected" });
    await expect(m.retrieve("x")).rejects.toMatchObject({ code: "rejected" });
    await expect(m.verifyWebhook("{}", {})).rejects.toMatchObject({
      code: "rejected",
    });
  });
});

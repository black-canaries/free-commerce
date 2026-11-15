import { ProviderError } from "./error";
import {
  assertChargeable,
  type Payment,
  type PaymentEvent,
  type PaymentProvider,
  paymentEventSchema,
  type Refund,
} from "./payment";

const NAME = "fake-payments";
const reject = (msg: string, code: "rejected" | "not_found" = "rejected") =>
  new ProviderError(NAME, code, msg);

/** Method tokens the fake understands; anything else is `rejected`. */
export const FAKE_TOKENS = {
  ok: "tok_ok",
  declined: "tok_declined",
  /** Needs a redirect; finish with `resolve`. */
  threeDs: "tok_3ds",
  /** Settles later; finish with `resolve`. */
  async: "tok_async",
  /** Throws a retryable `unavailable` error before any side effect. */
  unavailable: "tok_unavailable",
  /** Succeeds, but the saved method is declined off-session. */
  declineLater: "tok_decline_later",
} as const;

interface Record_ {
  payment: Payment;
  manual: boolean;
  token?: string;
  save: boolean;
  customerRef?: string;
  refunded: number;
}

/**
 * @experimental In-memory `PaymentProvider` covering every state and failure mode.
 * Webhooks are signed with `secret`; `delivery(id)` builds one for the payment's current state.
 */
export function createFakePayments(secret = "whsec_fake") {
  const payments = new Map<string, Record_>();
  const methods = new Map<string, { customerRef: string; token: string }>();
  let refundState: Refund["state"] = "succeeded";
  /** Input is compared as JSON, so key order matters; fine for a fake. */
  const replay = new Map<string, { input: string; result: unknown }>();
  let seq = 0;
  const next = (p: string) => `${p}_fake_${++seq}`;

  const once = async <T>(
    op: string,
    input: { idempotencyKey: string },
    run: () => T,
  ): Promise<T> => {
    const k = `${op}:${input.idempotencyKey}`;
    const body = JSON.stringify(input);
    const seen = replay.get(k);
    if (seen) {
      if (seen.input !== body) throw reject("idempotency key reused");
      return structuredClone(seen.result) as T;
    }
    const result = run();
    replay.set(k, { input: body, result: structuredClone(result) });
    return structuredClone(result);
  };

  const get = (id: string): Record_ => {
    const r = payments.get(id);
    if (!r) throw reject(id, "not_found");
    return r;
  };
  const set = (r: Record_, p: Partial<Payment>): Payment => {
    r.payment = { ...r.payment, ...p };
    if (r.payment.state !== "requires_action") delete r.payment.action;
    return r.payment;
  };
  const succeed = (r: Record_): Payment => {
    const patch: Partial<Payment> = {
      state: r.manual ? "authorized" : "captured",
    };
    if (r.save && r.customerRef && r.token) {
      const id = next("pm");
      methods.set(id, { customerRef: r.customerRef, token: r.token });
      patch.savedMethodId = id;
    }
    return set(r, patch);
  };
  const fail = (r: Record_, failureCode: string) =>
    set(r, { state: "failed", failureCode });

  const provider: PaymentProvider = {
    createPayment: (i) =>
      once("create", i, () => {
        assertChargeable(NAME, i.amount);
        if (i.saveMethod && !i.customerRef)
          throw reject("saveMethod needs customerRef");
        const id = next("pay");
        payments.set(id, {
          payment: {
            id,
            state: "requires_action",
            amount: i.amount,
            action: { type: "client", clientSecret: `${id}_secret` },
          },
          manual: i.captureMode === "manual",
          save: !!i.saveMethod,
          customerRef: i.customerRef,
          refunded: 0,
        });
        return get(id).payment;
      }),
    confirm: (i) =>
      once("confirm", i, () => {
        const r = get(i.paymentId);
        if (r.payment.state !== "requires_action")
          throw reject("payment cannot be confirmed");
        if (i.methodToken === FAKE_TOKENS.unavailable)
          throw new ProviderError(NAME, "unavailable", "down");
        r.token = i.methodToken;
        switch (i.methodToken) {
          case FAKE_TOKENS.ok:
          case FAKE_TOKENS.declineLater:
            return succeed(r);
          case FAKE_TOKENS.declined:
            return fail(r, "card_declined");
          case FAKE_TOKENS.threeDs:
            return set(r, {
              action: { type: "redirect", url: `fake://3ds/${r.payment.id}` },
            });
          case FAKE_TOKENS.async:
            return set(r, { state: "pending" });
          default:
            throw reject("unknown method token");
        }
      }),
    retrieve: async (id) => structuredClone(get(id).payment),
    capture: (i) =>
      once("capture", i, () => {
        const r = get(i.paymentId);
        assertChargeable(NAME, i.amount);
        if (r.payment.state !== "authorized")
          throw reject("only authorized payments can be captured");
        if (
          i.amount.currency !== r.payment.amount.currency ||
          i.amount.amount > r.payment.amount.amount
        )
          throw reject("capture exceeds authorization");
        r.manual = false;
        return set(r, { state: "captured", amount: i.amount });
      }),
    refund: (i) =>
      once("refund", i, (): Refund => {
        const r = get(i.paymentId);
        assertChargeable(NAME, i.amount);
        if (r.payment.state !== "captured")
          throw reject("only captured payments can be refunded");
        const { amount, currency } = r.payment.amount;
        if (
          i.amount.currency !== currency ||
          r.refunded + i.amount.amount > amount
        )
          throw reject("refund exceeds captured amount");
        if (refundState !== "failed") r.refunded += i.amount.amount;
        return { id: next("re"), amount: i.amount, state: refundState };
      }),
    chargeSavedMethod: (i) =>
      once("saved", i, () => {
        assertChargeable(NAME, i.amount);
        const m = methods.get(i.savedMethodId);
        if (!m || m.customerRef !== i.customerRef)
          throw reject(i.savedMethodId, "not_found");
        const id = next("pay");
        const r: Record_ = {
          payment: { id, state: "requires_action", amount: i.amount },
          manual: false,
          save: false,
          customerRef: i.customerRef,
          token: m.token,
          refunded: 0,
        };
        payments.set(id, r);
        if (m.token === FAKE_TOKENS.threeDs)
          return set(r, {
            action: { type: "redirect", url: `fake://3ds/${id}` },
          });
        return m.token === FAKE_TOKENS.declineLater
          ? fail(r, "card_declined")
          : succeed(r);
      }),
    async verifyWebhook(rawBody, headers) {
      if (headers["x-fake-signature"] !== signature(rawBody))
        throw reject("bad webhook signature");
      try {
        return paymentEventSchema.parse(JSON.parse(rawBody));
      } catch (cause) {
        throw new ProviderError(NAME, "rejected", "malformed webhook", {
          cause,
        });
      }
    },
  };

  /** Not cryptographic; never copy: it puts the secret in the header: the fake only has to fail on a wrong secret or a changed body. */
  const signature = (body: string) => `${secret}:${body.length}:${body}`;
  const sign = (body: string) => ({ "x-fake-signature": signature(body) });

  return Object.assign(provider, {
    /** Completes a `requires_action` (3DS) or `pending` (async) payment, as the customer or bank would. */
    resolve(paymentId: string, outcome: "success" | "failure"): Payment {
      const r = get(paymentId);
      if (
        r.payment.state !== "requires_action" &&
        r.payment.state !== "pending"
      )
        throw reject("nothing to resolve");
      return outcome === "success"
        ? succeed(r)
        : fail(r, "authentication_failed");
    },
    /** The next refunds settle as `pending` or `failed` (a failed refund frees the amount). */
    refundsAs(state: Refund["state"]): void {
      refundState = state;
    },
    /** Signs an arbitrary body as this provider would. */
    sign,
    /** A signature made with a different secret. */
    signWrong: (body: string) => ({
      "x-fake-signature": `other:${body.length}:${body}`,
    }),
    /** A signed webhook delivery for the payment's current state. */
    delivery(paymentId: string): {
      rawBody: string;
      headers: Record<string, string>;
    } {
      const event: PaymentEvent = {
        id: next("evt"),
        payment: structuredClone(get(paymentId).payment),
      };
      const rawBody = JSON.stringify(event);
      return { rawBody, headers: sign(rawBody) };
    },
  });
}

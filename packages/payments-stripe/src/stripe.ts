import {
  assertChargeable,
  type Payment,
  type PaymentEvent,
  type PaymentProvider,
  type PaymentState,
  ProviderError,
  paymentEventSchema,
  type Refund,
} from "@free-commerce/core";

const NAME = "stripe";
const API_VERSION = "2024-06-20";
const TOLERANCE_SECONDS = 300;

export interface StripePaymentsOptions {
  /** Secret or restricted key. Never logged or put in errors. */
  secretKey: string;
  /** Signing secret (`whsec_...`) of the webhook endpoint. */
  webhookSecret: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetch?: (req: Request) => Promise<Response>;
  /** Injectable clock (ms) for the webhook timestamp tolerance. */
  now?: () => number;
}

interface Intent {
  id: string;
  status: string;
  amount: number;
  amount_received?: number;
  currency: string;
  client_secret?: string;
  customer?: string | null;
  payment_method?: string | null;
  setup_future_usage?: string | null;
  cancellation_reason?: string | null;
  next_action?: { redirect_to_url?: { url?: string } } | null;
  last_payment_error?: { code?: string; decline_code?: string } | null;
}

interface StripeRefund {
  id: string;
  amount: number;
  currency: string;
  status?: string | null;
  payment_intent?: string | null;
}

interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Intent & StripeRefund };
}

const STATES: Record<string, PaymentState> = {
  requires_payment_method: "requires_action",
  requires_confirmation: "requires_action",
  requires_action: "requires_action",
  processing: "pending",
  requires_capture: "authorized",
  succeeded: "captured",
  canceled: "failed",
};

/** A decline leaves the intent reusable at Stripe, but for us the attempt is over, unless the bank wants authentication. */
function stateOf(i: Intent): PaymentState {
  const err = i.last_payment_error;
  if (i.status === "requires_payment_method" && err)
    return err.code === "authentication_required"
      ? "requires_action"
      : "failed";
  return STATES[i.status] ?? "failed";
}

function actionOf(i: Intent): Payment["action"] {
  if (!i.client_secret) return undefined;
  const url = i.next_action?.redirect_to_url?.url;
  return url
    ? { type: "redirect", url }
    : { type: "client", clientSecret: i.client_secret };
}

/** ISO 4217 has no decimals for these, but Stripe wants two-decimal amounts (multiples of 100). */
const STRIPE_x100 = new Set(["ISK", "UGX"]);
/** Three-decimal currencies: Stripe requires the last digit to be 0. */
const STRIPE_THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

const fromStripe = (amount: number, currency: string) =>
  STRIPE_x100.has(currency.toUpperCase()) ? amount / 100 : amount;

function toPayment(i: Intent): Payment {
  const state = stateOf(i);
  const err = i.last_payment_error;
  const saved =
    i.setup_future_usage && (state === "captured" || state === "authorized");
  return {
    id: i.id,
    state,
    amount: {
      amount: fromStripe(
        state === "captured" ? (i.amount_received ?? i.amount) : i.amount,
        i.currency,
      ),
      currency: i.currency.toUpperCase(),
    },
    action: state === "requires_action" ? actionOf(i) : undefined,
    savedMethodId: (saved && i.payment_method) || undefined,
    failureCode:
      state === "failed"
        ? (err?.decline_code ?? err?.code ?? i.cancellation_reason ?? undefined)
        : undefined,
  };
}

function toRefund(r: StripeRefund): Refund {
  const state =
    r.status === "succeeded"
      ? "succeeded"
      : r.status === "failed" || r.status === "canceled"
        ? "failed"
        : "pending";
  return {
    id: r.id,
    amount: {
      amount: fromStripe(r.amount, r.currency),
      currency: r.currency.toUpperCase(),
    },
    state,
  };
}

const hex = (s: string) =>
  /^(?:[0-9a-f]{2})+$/.test(s)
    ? Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16))
    : undefined;

/**
 * @experimental Stripe PaymentIntents over `fetch` (no SDK; edge-safe). `automatic_payment_methods`
 * lets the Payment Element offer cards, wallets and redirect methods per the dashboard settings.
 * `methodToken` is a `pm_...` id and `customerRef` a Stripe customer id (`cus_...`).
 */
export function createStripePayments(
  opts: StripePaymentsOptions,
): PaymentProvider {
  if (!/^[sr]k_(test|live)_\w+$/.test(opts.secretKey))
    throw new ProviderError(
      NAME,
      "rejected",
      "secretKey must be an sk_ or rk_ key",
    );
  if (!/^whsec_\S+$/.test(opts.webhookSecret))
    throw new ProviderError(
      NAME,
      "rejected",
      "webhookSecret must be a whsec_ secret",
    );
  const send = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const fail = (
    code: ConstructorParameters<typeof ProviderError>[1],
    m: string,
  ) => new ProviderError(NAME, code, m);

  const httpError = (status: number, message: string) => {
    const m = `HTTP ${status}: ${message}`;
    if (status === 404) return fail("not_found", m);
    if (status === 409 || status === 429 || status >= 500)
      return fail("unavailable", m);
    return fail("rejected", m);
  };

  async function request(
    method: "GET" | "POST",
    path: string,
    form: Record<string, string | undefined>,
    idempotencyKey?: string,
  ): Promise<Response> {
    const body = new URLSearchParams(
      Object.entries(form).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.secretKey}`,
      "stripe-version": API_VERSION,
      "content-type": "application/x-www-form-urlencoded",
      ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
    };
    try {
      return await send(
        new Request(`https://api.stripe.com${path}`, {
          method,
          headers,
          body: method === "POST" ? body : undefined,
        }),
      );
    } catch (e) {
      throw new ProviderError(NAME, "unavailable", "request failed", {
        cause: e,
      });
    }
  }

  /** Parsed JSON; a 402 carrying a payment_intent (a decline) is returned as that intent. */
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    form: Record<string, string | undefined> = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const res = await request(method, path, form, idempotencyKey);
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; type?: string; payment_intent?: unknown };
    };
    if (res.ok) return json as T;
    if (res.status === 402 && json.error?.payment_intent)
      return json.error.payment_intent as T;
    throw httpError(
      res.status,
      json.error?.code ?? json.error?.type ?? "error",
    );
  }

  const intent = (id: string) =>
    call<Intent>("GET", `/v1/payment_intents/${encodeURIComponent(id)}`);
  const sameCurrency = async (id: string, currency: string) => {
    const i = await intent(id);
    if (i.currency.toUpperCase() !== currency)
      throw fail("rejected", "currency mismatch");
    return i;
  };
  const money = (m: { amount: number; currency: string }) => {
    assertChargeable(NAME, m);
    if (STRIPE_THREE_DECIMAL.has(m.currency) && m.amount % 10 !== 0)
      throw fail(
        "rejected",
        "amount must be a multiple of 10 for this currency",
      );
    const minor = STRIPE_x100.has(m.currency) ? m.amount * 100 : m.amount;
    return { amount: String(minor), currency: m.currency.toLowerCase() };
  };

  async function signatureOk(
    rawBody: string,
    header: string | undefined,
  ): Promise<boolean> {
    const parts = (header ?? "").split(",");
    const t = parts.find((p) => p.startsWith("t="))?.slice(2) ?? "";
    if (
      !/^\d+$/.test(t) ||
      Math.abs(now() / 1000 - Number(t)) > TOLERANCE_SECONDS
    )
      return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(opts.webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${t}.${rawBody}`);
    // subtle.verify compares in constant time
    const checks = await Promise.all(
      parts
        .filter((p) => p.startsWith("v1="))
        .map((p) => hex(p.slice(3)))
        .map((s) => s && crypto.subtle.verify("HMAC", key, s, data)),
    );
    return checks.some(Boolean);
  }

  /** Never forwards the client secret that Stripe puts in event payloads. */
  async function snapshot(ev: StripeEvent) {
    const obj = ev.data?.object;
    if (!obj) return {};
    if (ev.type?.startsWith("payment_intent."))
      return { payment: { ...toPayment(obj), action: undefined } };
    if (ev.type?.startsWith("refund.") && obj.payment_intent)
      return {
        payment: {
          ...toPayment(await intent(obj.payment_intent)),
          action: undefined,
        },
        refund: toRefund(obj),
      };
    return {};
  }

  async function verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<PaymentEvent> {
    if (!(await signatureOk(rawBody, headers["stripe-signature"])))
      throw fail("rejected", "invalid webhook signature");
    const ev = JSON.parse(rawBody) as StripeEvent;
    const parsed = paymentEventSchema.safeParse({
      id: ev.id,
      ...(await snapshot(ev)),
    });
    if (!parsed.success) throw fail("rejected", "unsupported webhook event");
    return parsed.data;
  }

  return {
    async createPayment(i) {
      const m = money(i.amount);
      if (i.saveMethod && !i.customerRef)
        throw fail("rejected", "saveMethod requires customerRef");
      return toPayment(
        await call<Intent>(
          "POST",
          "/v1/payment_intents",
          {
            ...m,
            "automatic_payment_methods[enabled]": "true",
            capture_method: i.captureMode === "manual" ? "manual" : "automatic",
            "metadata[reference]": i.reference,
            customer: i.customerRef,
            setup_future_usage: i.saveMethod ? "off_session" : undefined,
          },
          i.idempotencyKey,
        ),
      );
    },
    async confirm(i) {
      if (!/^pm_[A-Za-z0-9_]+$/.test(i.methodToken))
        throw fail("rejected", "methodToken must be a pm_ id");
      return toPayment(
        await call<Intent>(
          "POST",
          `/v1/payment_intents/${encodeURIComponent(i.paymentId)}/confirm`,
          { payment_method: i.methodToken, return_url: i.returnUrl },
          i.idempotencyKey,
        ),
      );
    },
    async retrieve(id) {
      return toPayment(await intent(id));
    },
    async capture(i) {
      const m = money(i.amount);
      await sameCurrency(i.paymentId, m.currency.toUpperCase());
      return toPayment(
        await call<Intent>(
          "POST",
          `/v1/payment_intents/${encodeURIComponent(i.paymentId)}/capture`,
          { amount_to_capture: m.amount },
          i.idempotencyKey,
        ),
      );
    },
    async refund(i) {
      const m = money(i.amount);
      await sameCurrency(i.paymentId, m.currency.toUpperCase());
      return toRefund(
        await call<StripeRefund>(
          "POST",
          "/v1/refunds",
          { payment_intent: i.paymentId, amount: m.amount },
          i.idempotencyKey,
        ),
      );
    },
    async chargeSavedMethod(i) {
      const m = money(i.amount);
      const pm = await call<{ customer?: string | null }>(
        "GET",
        `/v1/payment_methods/${encodeURIComponent(i.savedMethodId)}`,
      );
      if (pm.customer !== i.customerRef)
        throw fail("not_found", "saved method not found");
      return toPayment(
        await call<Intent>(
          "POST",
          "/v1/payment_intents",
          {
            ...m,
            customer: i.customerRef,
            payment_method: i.savedMethodId,
            off_session: "true",
            confirm: "true",
            "metadata[reference]": i.reference,
          },
          i.idempotencyKey,
        ),
      );
    },
    verifyWebhook,
  };
}

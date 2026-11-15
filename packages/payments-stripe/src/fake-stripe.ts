import { createHmac } from "node:crypto";

type Form = Record<string, string>;
interface Intent {
  [k: string]: unknown;
  id: string;
  status: string;
  amount: number;
  currency: string;
  amount_received: number;
  refunded: number;
  capture_method: string;
  customer?: string;
  payment_method?: string;
  setup_future_usage?: string;
  client_secret: string;
  last_payment_error?: { code: string; decline_code?: string };
  next_action?: { redirect_to_url: { url: string } };
}

export const SECRET = "sk_test_fake";
export const WHSEC = "whsec_fake";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });
const err = (status: number, message: string, extra: object = {}) =>
  json(status, { error: { message, ...extra } });

/** Just enough of Stripe's PaymentIntent API to run the conformance suite offline. */
export function fakeStripe() {
  const intents = new Map<string, Intent>();
  const methods = new Map<string, { customer?: string }>();
  const keys = new Map<string, { sig: string; res: unknown; status: number }>();
  const requests: Request[] = [];
  let n = 0;

  const settle = (i: Intent, token: string) => {
    i.payment_method = token;
    if (i.setup_future_usage && i.customer)
      methods.set(token, { customer: i.customer });
    if (token === "pm_decline")
      i.last_payment_error = {
        code: "card_declined",
        decline_code: "insufficient_funds",
      };
    else if (token === "pm_3ds") {
      i.status = "requires_action";
      i.next_action = {
        redirect_to_url: { url: "https://hooks.stripe.test/3ds" },
      };
    } else if (token === "pm_async") i.status = "processing";
    else if (i.capture_method === "manual") i.status = "requires_capture";
    else {
      i.status = "succeeded";
      i.amount_received = i.amount;
    }
  };

  const intentOr404 = (
    id: string | undefined,
    then: (i: Intent) => Response,
  ) => {
    const i = intents.get(id ?? "");
    return i ? then(i) : err(404, "no such payment_intent");
  };
  const create = (f: Form) => {
    const i: Intent = {
      id: `pi_${++n}`,
      status: "requires_payment_method",
      amount: Number(f.amount),
      currency: f.currency ?? "",
      amount_received: 0,
      refunded: 0,
      capture_method: f.capture_method ?? "automatic",
      customer: f.customer,
      setup_future_usage: f.setup_future_usage,
      client_secret: `pi_${n}_secret_x`,
    };
    intents.set(i.id, i);
    if (f.confirm) settle(i, f.payment_method ?? "");
    return json(200, i);
  };
  const refund = (f: Form) =>
    intentOr404(f.payment_intent, (i) => {
      const amount = Number(f.amount);
      if (i.status !== "succeeded" || amount > i.amount_received - i.refunded)
        return err(400, "Refund amount is greater than unrefunded amount");
      i.refunded += amount;
      return json(200, {
        id: `re_${++n}`,
        amount,
        currency: i.currency,
        status: "succeeded",
        payment_intent: i.id,
      });
    });
  const confirm = (i: Intent, f: Form) => {
    settle(i, f.payment_method ?? "");
    return i.last_payment_error
      ? err(402, "declined", { payment_intent: i })
      : json(200, i);
  };
  const capture = (i: Intent, f: Form) => {
    const amount = Number(f.amount_to_capture ?? i.amount);
    if (i.status !== "requires_capture" || amount > i.amount)
      return err(400, "cannot capture");
    i.status = "succeeded";
    i.amount_received = amount;
    return json(200, i);
  };

  const route = (method: string, path: string, f: Form): Response => {
    const [, , kind, id, action] = path.split("/");
    if (path === "/v1/payment_intents") return create(f);
    if (path === "/v1/refunds") return refund(f);
    if (kind === "payment_methods") {
      const m = methods.get(id ?? "");
      return m ? json(200, m) : err(404, "no such payment method");
    }
    return intentOr404(id, (i) => {
      if (method === "GET") return json(200, i);
      if (action === "confirm") return confirm(i, f);
      return action === "capture" ? capture(i, f) : err(404, "unknown route");
    });
  };

  const fetch = async (req: Request): Promise<Response> => {
    requests.push(req.clone());
    const url = new URL(req.url);
    const f = Object.fromEntries(new URLSearchParams(await req.text())) as Form;
    const key = req.headers.get("idempotency-key");
    const sig = `${req.method} ${url.pathname} ${JSON.stringify(f)}`;
    const seen = key ? keys.get(key) : undefined;
    if (seen)
      return seen.sig === sig
        ? json(seen.status, seen.res)
        : err(
            400,
            "Keys for idempotent requests can only be used with the same parameters",
          );
    const res = route(req.method, url.pathname, f);
    if (key)
      keys.set(key, { sig, res: await res.clone().json(), status: res.status });
    return res;
  };

  return { fetch, requests, intents };
}

export function signed(body: string, t: number, secret = WHSEC) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { "stripe-signature": `t=${t},v1=${v1}` };
}

import { newId } from "@free-commerce/schema";
import type { DomainEvent } from "../events/events";
import type { Page, Repository } from "../repositories";

/** @experimental `*` in `events` matches every event type. */
export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  /** Why delivery stopped, shown to the merchant; null while enabled. */
  disabledReason: string | null;
  /** AES-GCM ciphertext of the signing secret (see `encryptSecret`); never returned by the API. */
  secretCipher: string;
  /** First characters of the secret, to tell endpoints apart. Not usable to sign. */
  hint: string;
  createdAt: string;
}

/** @experimental `pending`: will be (re)tried at `nextAttemptAt`; `failed`: retries exhausted or endpoint disabled. */
export interface WebhookDelivery {
  /** Deterministic per (event, endpoint), so fan-out is idempotent. */
  id: string;
  endpointId: string;
  event: DomainEvent;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
  /** HTTP status of the last attempt, null when it never got a response. */
  lastStatus: number | null;
  /** Short reason, e.g. `HTTP 503` or `timeout`. Never a response body, payload or secret. */
  lastError: string | null;
  createdAt: string;
}

/** @experimental Deliveries are never rewritten except through `save` by the worker. */
export interface WebhookDeliveryRepository extends Repository<WebhookDelivery> {
  /** Inserts unless the id exists (then does nothing). */
  create(delivery: WebhookDelivery): Promise<void>;
  /** `pending` deliveries with `nextAttemptAt <= now`, oldest first. */
  due(now: string, limit: number): Promise<WebhookDelivery[]>;
  /** Newest first; `cursor` is the last id of the previous page. */
  listFor(
    endpointId: string,
    query: { limit: number; cursor?: string },
  ): Promise<Page<WebhookDelivery>>;
}

type Db = {
  webhookEndpoints: Repository<WebhookEndpoint>;
  webhookDeliveries: WebhookDeliveryRepository;
};

export class WebhookError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "not_found" = "invalid",
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

/** Seconds to wait after failed attempt n (1-based). A 6th failure exhausts the delivery. */
export const WEBHOOK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_SECONDS.length + 1;
const TIMEOUT_MS = 10_000;
/** Signatures older or newer than this are rejected by `verifyWebhook`. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const enc = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------------------------------------------------
// Signature scheme (Standard Webhooks style). Headers on every delivery:
//   webhook-id         the event id (same on retries and replays: receivers dedupe on it)
//   webhook-timestamp  unix seconds, set on every attempt
//   webhook-signature  `v1,<base64 HMAC-SHA256>` of `${id}.${timestamp}.${body}`, keyed with the UTF-8
//                      bytes of the whole secret string (including its `whsec_` prefix)
// Receivers must verify the signature over the raw body, reject timestamps outside the tolerance
// (replay protection) and compare in constant time (`verifyWebhook` does all three).
// ---------------------------------------------------------------------------------------------------------

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );

/** @experimental `v1,<base64>` signature header value. */
export const signWebhook = async (
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> =>
  `v1,${b64(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(`${id}.${timestamp}.${body}`))))}`;

/**
 * @experimental For receivers (and tests). `signature` may hold several space-separated `v1,...` values;
 * any one matching is enough. Uses `crypto.subtle.verify`, which compares in constant time.
 */
export const verifyWebhook = async (input: {
  secret: string;
  id: string;
  timestamp: string;
  signature: string;
  body: string;
  /** Unix seconds. */
  now: number;
  toleranceSeconds?: number;
}): Promise<boolean> => {
  const ts = Number(input.timestamp);
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isInteger(ts) || Math.abs(input.now - ts) > tolerance)
    return false;
  const key = await hmacKey(input.secret, "verify");
  const data = enc.encode(`${input.id}.${ts}.${input.body}`);
  for (const part of input.signature.split(" ")) {
    if (!part.startsWith("v1,")) continue;
    try {
      if (await crypto.subtle.verify("HMAC", key, unb64(part.slice(3)), data))
        return true;
    } catch {
      // malformed base64: not a match
    }
  }
  return false;
};

// ---------------------------------------------------------------------------------------------------------
// Secrets are encrypted (not hashed) because signing needs the plaintext. AES-256-GCM, key supplied by the
// deployment (base64, 32 bytes); stored as base64(iv || ciphertext).
// ---------------------------------------------------------------------------------------------------------

const aesKey = (keyB64: string, usage: "encrypt" | "decrypt") => {
  const raw = unb64(keyB64);
  if (raw.byteLength !== 32)
    throw new WebhookError("webhook encryption key must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
};

/** @experimental */
export const encryptSecret = async (
  keyB64: string,
  secret: string,
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await aesKey(keyB64, "encrypt"),
      enc.encode(secret),
    ),
  );
  return b64(Uint8Array.from([...iv, ...ct]));
};

/** @experimental */
export const decryptSecret = async (
  keyB64: string,
  cipher: string,
): Promise<string> => {
  const raw = unb64(cipher);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12) },
    await aesKey(keyB64, "decrypt"),
    raw.slice(12),
  );
  return new TextDecoder().decode(plain);
};

// ---------------------------------------------------------------------------------------------------------
// SSRF guard. Literal checks only: no DNS in pure core, so hostnames are additionally checked through the
// optional `resolve` hook (see `deliverDueWebhooks`).
// ---------------------------------------------------------------------------------------------------------

const v4 = (h: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m ? m.slice(1).map(Number) : null;
};

const privateV4 = ([a = 0, b = 0, c = 0]: number[]): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  a >= 224 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 0 && c === 0) ||
  (a === 192 && b === 0 && c === 2) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) ||
  (a === 198 && b === 51 && c === 100) ||
  (a === 203 && b === 0 && c === 113);

/** Expands an IPv6 literal (no brackets, no embedded dotted quad: WHATWG URL already normalises it) to 8 groups. */
const groups6 = (h: string): number[] | null => {
  const [head = "", tail, extra] = h.split("::");
  if (extra !== undefined) return null;
  const parts = (s: string) => (s === "" ? [] : s.split(":"));
  const left = parts(head);
  const right = tail === undefined ? [] : parts(tail);
  const fill = 8 - left.length - right.length;
  if (tail === undefined ? fill !== 0 : fill < 1) return null;
  const all = [
    ...left,
    ...Array(tail === undefined ? 0 : fill).fill("0"),
    ...right,
  ];
  const nums = all.map((g) =>
    /^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN,
  );
  return nums.some(Number.isNaN) ? null : nums;
};

const privateV6 = (g: number[]): boolean => {
  const [g0 = 0, g1 = 0, g2 = 0, , , g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = (hi: number, lo: number) =>
    privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff)
    return embedded(g6, g7); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b) return embedded(g6, g7); // NAT64
  if (g0 === 0x2002) return embedded(g1, g2); // 6to4
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link local
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0xdb8) // documentation
  );
};

/** True when `host` (a URL hostname or a resolved address) is an address that must not be reached. */
export const isPrivateAddress = (host: string): boolean => {
  const bare = host.replace(/^\[|\]$/g, "");
  const a = v4(bare);
  if (a) return a.some((n) => n > 255) || privateV4(a);
  const g = bare.includes(":") ? groups6(bare) : null;
  return bare.includes(":") ? !g || privateV6(g) : false;
};

const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/;

/** @experimental Why `raw` cannot be a webhook URL, or null when it can. `dev` allows http and private hosts. */
export const webhookUrlProblem = (raw: string, dev = false): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:" && !(dev && url.protocol === "http:"))
    return "URL must use https";
  if (url.username || url.password) return "URL must not contain credentials";
  if (dev) return null;
  const host = url.hostname;
  if (LOCAL_NAME.test(host) || (!host.includes(".") && !host.includes(":")))
    return "host is not public";
  if (isPrivateAddress(host)) return "host is a private or reserved address";
  return null;
};

// ---------------------------------------------------------------------------------------------------------
// Management and fan-out
// ---------------------------------------------------------------------------------------------------------

const matches = (e: WebhookEndpoint, type: string) =>
  e.events.includes("*") || e.events.includes(type);

const checkEvents = (events: string[]) => {
  if (
    events.length === 0 ||
    events.length > 50 ||
    events.some((t) => !t || t.length > 100)
  )
    throw new WebhookError("events must be 1-50 non-empty event types");
};

export interface NewWebhookEndpoint {
  url: string;
  events: string[];
}

/** Returns the stored endpoint and the secret, which is shown once and cannot be recovered. */
export const createWebhookEndpoint = async (
  db: Pick<Db, "webhookEndpoints">,
  input: NewWebhookEndpoint,
  opts: { key: string; dev?: boolean; now: number },
): Promise<{ endpoint: WebhookEndpoint; secret: string }> => {
  const problem = webhookUrlProblem(input.url, opts.dev);
  if (problem) throw new WebhookError(`Webhook URL rejected: ${problem}`);
  checkEvents(input.events);
  const secret = `whsec_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const endpoint: WebhookEndpoint = {
    id: newId("whk", opts.now),
    url: input.url,
    events: [...new Set(input.events)],
    enabled: true,
    disabledReason: null,
    secretCipher: await encryptSecret(opts.key, secret),
    hint: secret.slice(0, 10),
    createdAt: new Date(opts.now).toISOString(),
  };
  await db.webhookEndpoints.save(endpoint);
  return { endpoint, secret };
};

export const getWebhookEndpoint = async (
  db: Pick<Db, "webhookEndpoints">,
  id: string,
): Promise<WebhookEndpoint> => {
  const found = await db.webhookEndpoints.get(id);
  if (!found) throw new WebhookError("Webhook endpoint not found", "not_found");
  return found;
};

/** Changing the URL is checked like creation; enabling clears the disabled reason. */
export const updateWebhookEndpoint = async (
  db: Pick<Db, "webhookEndpoints">,
  id: string,
  patch: { url?: string; events?: string[]; enabled?: boolean },
  dev = false,
): Promise<WebhookEndpoint> => {
  const current = await getWebhookEndpoint(db, id);
  if (patch.url !== undefined) {
    const problem = webhookUrlProblem(patch.url, dev);
    if (problem) throw new WebhookError(`Webhook URL rejected: ${problem}`);
  }
  if (patch.events) checkEvents(patch.events);
  const enabled = patch.enabled ?? current.enabled;
  const next: WebhookEndpoint = {
    ...current,
    url: patch.url ?? current.url,
    events: patch.events ? [...new Set(patch.events)] : current.events,
    enabled,
    disabledReason: enabled
      ? null
      : patch.enabled === false
        ? "Disabled by a staff member"
        : current.disabledReason,
  };
  await db.webhookEndpoints.save(next);
  return next;
};

/** Event handler for the outbox relay (`bus.subscribe("*", ...)`): one pending delivery per matching endpoint. Idempotent. */
export const fanOutWebhooks = async (
  db: Db,
  event: DomainEvent,
  now: number,
): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page: Page<WebhookEndpoint> = await db.webhookEndpoints.list({
      limit: 100,
      cursor,
    });
    for (const e of page.items)
      if (e.enabled && matches(e, event.type))
        await db.webhookDeliveries.create({
          id: `whd_${event.id}.${e.id}`,
          endpointId: e.id,
          event,
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(now).toISOString(),
          lastStatus: null,
          lastError: null,
          createdAt: new Date(now).toISOString(),
        });
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
};

/** Manual replay: the delivery goes back to `pending` with a fresh attempt budget and the same event id. */
export const replayWebhookDelivery = async (
  db: Db,
  id: string,
  now: number,
): Promise<WebhookDelivery> => {
  const delivery = await db.webhookDeliveries.get(id);
  if (!delivery) throw new WebhookError("Delivery not found", "not_found");
  const endpoint = await getWebhookEndpoint(db, delivery.endpointId);
  if (!endpoint.enabled)
    throw new WebhookError("Enable the endpoint before replaying");
  const next: WebhookDelivery = {
    ...delivery,
    status: "pending",
    attempts: 0,
    nextAttemptAt: new Date(now).toISOString(),
    lastStatus: null,
    lastError: null,
  };
  await db.webhookDeliveries.save(next);
  return next;
};

// ---------------------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------------------

export interface WebhookWorkerDeps {
  db: Db;
  /** Base64 32-byte key the secrets were encrypted with. */
  key: string;
  fetch: typeof fetch;
  now: () => number;
  /** Allows http and private hosts (local development only). */
  dev?: boolean;
  /**
   * Resolves a hostname to its addresses so DNS names pointing at private ranges are refused. Not part
   * of pure core: a Node deployment passes `node:dns`. The address is not pinned for the connection.
   */
  resolve?: (host: string) => Promise<string[]>;
}

type Outcome =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

/** Why the URL must not be called right now (literal check, then DNS when a resolver is given), or null. */
const blockReason = async (
  d: WebhookWorkerDeps,
  url: string,
): Promise<string | null> => {
  const problem = webhookUrlProblem(url, d.dev);
  if (problem) return `blocked: ${problem}`;
  const host = new URL(url).hostname;
  if (!d.resolve || d.dev || host.includes(":") || v4(host)) return null;
  try {
    return (await d.resolve(host)).some(isPrivateAddress)
      ? "blocked: host resolves to a private address"
      : null;
  } catch {
    return "DNS lookup failed";
  }
};

/** One signed POST. Redirects are not followed (a 3xx fails) and the response body is never read. */
const send = async (
  d: WebhookWorkerDeps,
  endpoint: WebhookEndpoint,
  delivery: WebhookDelivery,
): Promise<Outcome> => {
  const blocked = await blockReason(d, endpoint.url);
  if (blocked) return { ok: false, status: null, error: blocked };
  const { event } = delivery;
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    createdAt: event.occurredAt,
    data: event.payload,
  });
  const timestamp = Math.floor(d.now() / 1000);
  try {
    const secret = await decryptSecret(d.key, endpoint.secretCipher);
    const res = await d.fetch(endpoint.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "webhook-id": event.id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": await signWebhook(
          secret,
          event.id,
          timestamp,
          body,
        ),
      },
      body,
    });
    await res.body?.cancel();
    return res.status >= 200 && res.status < 300
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      status: null,
      error: timedOut ? "timeout" : "network error",
    };
  }
};

/**
 * @experimental Attempts every due delivery once (the scheduler calls this on a tick). A failure schedules a
 * retry with backoff; the last failure marks the delivery `failed` and disables the endpoint with a visible
 * reason. Two concurrent workers may both attempt a delivery: receivers dedupe on `webhook-id`.
 * Returns the number of deliveries attempted.
 */
export const deliverDueWebhooks = async (
  d: WebhookWorkerDeps,
  limit = 50,
): Promise<number> => {
  const nowIso = new Date(d.now()).toISOString();
  const due = await d.db.webhookDeliveries.due(nowIso, limit);
  for (const delivery of due) {
    const endpoint = await d.db.webhookEndpoints.get(delivery.endpointId);
    if (!endpoint?.enabled) {
      await d.db.webhookDeliveries.save({
        ...delivery,
        status: "failed",
        nextAttemptAt: null,
        lastError: "endpoint disabled",
      });
      continue;
    }
    const out = await send(d, endpoint, delivery);
    const attempts = delivery.attempts + 1;
    if (out.ok) {
      await d.db.webhookDeliveries.save({
        ...delivery,
        status: "succeeded",
        attempts,
        nextAttemptAt: null,
        lastStatus: out.status,
        lastError: null,
      });
      continue;
    }
    const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;
    const wait = WEBHOOK_BACKOFF_SECONDS[attempts - 1];
    await d.db.webhookDeliveries.save({
      ...delivery,
      status: exhausted ? "failed" : "pending",
      attempts,
      nextAttemptAt:
        exhausted || wait === undefined
          ? null
          : new Date(d.now() + wait * 1000).toISOString(),
      lastStatus: out.status,
      lastError: out.error,
    });
    if (exhausted)
      await d.db.webhookEndpoints.save({
        ...endpoint,
        enabled: false,
        disabledReason: `Delivery ${delivery.id} failed ${attempts} times (last: ${out.error})`,
      });
  }
  return due.length;
};

---
status: accepted
---
# Outbound webhooks

Task 2.13. Merchants get signed, retried, replayable HTTP callbacks for domain events, driven by the outbox (ADR 0020).

## Decisions

- **Two repositories** on `Repositories` (additive): `webhookEndpoints` (plain document repository) and `webhookDeliveries` (document repository plus `create`, `due`, `listFor`). Both adapters pass the testkit's `webhookCases`; Postgres stores JSON documents with an expression index for due deliveries.
- **Fan-out is an outbox subscriber**: `bus.subscribe("*", (e) => fanOutWebhooks(db, e, now))` (the bus gained a `"*"` wildcard). It writes one `pending` delivery per enabled, matching endpoint with the deterministic id `whd_<eventId>.<endpointId>`, so at-least-once relay never duplicates. Fan-out and sending are separate steps: a slow or broken endpoint never blocks the outbox (this removes ADR 0020's head-of-line concern for webhooks).
- **Delivery is a function** (`deliverDueWebhooks`) called by the scheduler tick (2.11) or any host loop; no timers in core. It attempts each due delivery once. Concurrent workers may both send: receivers dedupe on `webhook-id`.
- **Retries**: backoff 1 min, 5 min, 30 min, 2 h, 12 h; the 6th failure marks the delivery `failed` and disables the endpoint with a visible `disabledReason` (delivery id, count, last error). Any non-2xx, timeout (10 s) or network error is a failure. Re-enabling is a staff action (`PATCH enabled: true`); `replay` resets a delivery to `pending` with a fresh budget and the same event id.
- **Signature** (Standard Webhooks style). Each request carries `webhook-id` (the event id; identical on retries and replays), `webhook-timestamp` (unix seconds, refreshed per attempt) and `webhook-signature: v1,<base64>`, the HMAC-SHA256 of `<id>.<timestamp>.<raw body>` keyed with the UTF-8 bytes of the whole secret string (`whsec_...`). Receivers must verify over the raw body, reject timestamps more than 300 s off, and compare in constant time; core exports `verifyWebhook` (Web Crypto `subtle.verify`, constant time) for tests and Node receivers. The signature header may carry several space-separated `v1,` values.
- **Body**: `{ id, type, createdAt, data }`.
- **Secrets are encrypted, not hashed**, because signing needs the plaintext. AES-256-GCM (Web Crypto) with a deployment key (`AppDeps.webhookKey`, base64 32 bytes, kept outside the database); stored as `base64(iv || ciphertext)`. The secret is returned only by the create response (marked `sensitive`, so idempotency never stores it) and is never in audit entries, lists or logs. No rotation in v0.1: delete-and-recreate is a new endpoint (disable the old one).
- **SSRF**: https only and no credentials, validated on create, update and again before every send (`webhookUrlProblem`). Blocks `localhost`, `.local/.internal/.lan` names, single-label hosts, and private, loopback, link-local, CGNAT, multicast, reserved and documentation IPv4/IPv6 ranges, including v4-mapped, NAT64 and 6to4 forms (WHATWG URL already canonicalises decimal/hex/octal IPv4). Redirects are never followed (`redirect: "manual"`; a 3xx is a failure). The response body is cancelled unread, so response size is zero; the request has a 10 s timeout. `AppDeps.allowInsecureWebhooks` (dev) permits http and local hosts.
- **Admin routes** under `/admin/webhooks` map to the `settings` permission group (staff read, owner write). Every mutation is audited with host and event filter only. The delivery log returns event id/type, attempts, status and a short error, never payloads or response bodies.

## Consequences

- **DNS rebinding is only partly covered.** Core cannot resolve DNS, so a hostname that resolves to a private address is blocked only if the host passes `WebhookWorkerDeps.resolve` (a Node deployment supplies a `node:dns` resolver), and the connection is not pinned to the checked address. Production deployments should additionally send webhooks through an egress proxy or network policy that denies private ranges.
- Delivered and failed deliveries are never purged (retention belongs to the 2.11 sweepers).
- Event payload fields are sent as emitted; emitting modules decide what personal data an event carries (2.9 owns export/erasure of stored deliveries).

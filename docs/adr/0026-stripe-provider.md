---
status: accepted
---
# Stripe payment provider

Task 2.3 (🔒). `@free-commerce/payments-stripe` implements `PaymentProvider` (ADR 0022) over Stripe's REST API with `fetch` and Web Crypto. **No dependency**: the `stripe` SDK is Node-oriented and large, and we use seven endpoints. API version is pinned in code.

## Decisions

- **PaymentIntents with `automatic_payment_methods`**: the Payment Element shows cards, wallets (Apple/Google Pay) and redirect methods per dashboard settings; no per-method code. `methodToken` is a `pm_` id (anything else, e.g. a PAN, is refused before any request); `customerRef` is a Stripe customer id.
- **State map**: `requires_payment_method|requires_confirmation|requires_action` → `requires_action`; `processing` → `pending`; `requires_capture` → `authorized`; `succeeded` → `captured` (amount = `amount_received`, so partial capture shows the captured part); `canceled` → `failed`. A decline (`requires_payment_method` + `last_payment_error`) is `failed` with `decline_code`; the saga starts a new payment to retry. Exception: `authentication_required` stays `requires_action`, with the client secret, so an off-session charge can be completed by the customer (SCA). A decline on confirm arrives as HTTP 402 with the intent attached and becomes a `failed` Payment, not an error.
- **Action**: redirect URL when Stripe gives one, else the client secret (3DS via Stripe.js). Webhook events never carry the action (Stripe puts the secret in payloads).
- **Errors**: 404 → `not_found`; 409, 429, 5xx and network failures → `unavailable` (retryable); other 4xx (including Stripe's idempotency-key-reuse error) → `rejected`. Messages carry Stripe's message and status, never the key.
- **Idempotency**: our `idempotencyKey` is sent as Stripe's `Idempotency-Key` on every mutating call. Capture/refund first read the intent to check currency (Stripe's calls carry none). `chargeSavedMethod` first reads the payment method and returns `not_found` unless it belongs to `customerRef`.
- **Webhooks**: `Stripe-Signature` HMAC-SHA256 over `t.rawBody`, any matching `v1` accepted (secret rotation), constant-time `subtle.verify`, 5-minute timestamp tolerance (replay window). `payment_intent.*` events map the snapshot; `refund.*` events fetch the intent and attach the refund. Anything else, or a signed body failing `paymentEventSchema`, is `rejected`: **subscribe the endpoint only to `payment_intent.*` and `refund.*`**. `event.id` is Stripe's event id; **the saga dedupes on it** and gates updates with `PAYMENT_STATE_TRANSITIONS` (snapshots can be stale).
- **Not covered** (as in ADR 0022): voiding an authorization, disputes, payment-method management, Connect.

## Testing

Unit tests run `paymentConformance` plus mapping/webhook/error tests against an in-memory Stripe fake (`fake-stripe.ts`, test-only; no network, no secrets). `stripe.live.test.ts` runs the same conformance against Stripe test mode (`pm_card_visa`) and is skipped unless `STRIPE_TEST_KEY` is set; it refuses non-test keys.

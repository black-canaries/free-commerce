---
status: accepted
---
# Payment provider interface, manual provider, and fit for recurring billing

Task 2.2 (🔒). `PaymentProvider` follows ADR 0007; fake and `paymentConformance` are exported from `@free-commerce/core/testing`. No new dependency.

## Decisions

- **States** (`PaymentState`): `requires_action | pending | authorized | captured | failed`. A new payment starts `requires_action` with a `client` action (client secret for the provider's SDK/Payment Element), so "customer must act" is one state whether it means entering a method, 3DS or a redirect. `PAYMENT_STATE_TRANSITIONS` lists forward moves only; webhook consumers apply an update only if listed for the stored state, which makes late and out-of-order deliveries harmless. This is the provider's view; the order's `paymentStatus` (ADR 0013) is derived by the saga.
- **A decline is a `failed` Payment, not an error.** `ProviderError` is for outages (`unavailable`, retryable), bad input and unknown ids (`rejected`, `not_found`).
- **No raw card data, ever.** Methods arrive as opaque provider tokens (`methodToken`); the fake rejects anything else. Webhook verification takes the exact raw body plus lower-case headers and throws `rejected` on a bad or missing signature; events carry a unique `id` for consumer dedupe.
- **Idempotency**: every mutating method takes `idempotencyKey`; same key and input returns the first result, same key with different input is `rejected`. Conformance enforces it.
- **Capture/refund amounts are explicit** `Money`: capture ≤ authorized (remainder released), cumulative refunds ≤ captured. `refund` returns a `Refund` (can be `pending`), not a Payment, so partial refunds need no payment-level state.
- **Manual provider** (`createManualPayments`): bank transfer, cash, admin-marked. Stateless, ids derive from idempotency keys; `capture` is "mark paid". It is exempt from conformance and from reconciliation (`retrieve` unsupported); refund limits are enforced by `refundOrder`.
- **Deferred**: voiding an authorization (`cancel`; authorizations expire to `failed`), disputes/chargebacks, payment-method management UI. Add with the Stripe adapter (2.3) if needed.

## Recurring billing fit (nothing built)

- `chargeSavedMethod` is an off-session charge of an arbitrary `amount` + `reference`, creating its own Payment; nothing ties it to a cart or a single use. A subscription scheduler later calls it per period (or the provider bills natively and reports each invoice payment through webhooks as a new `Payment` event; `PaymentEvent` does not require a prior `createPayment`).
- Saved methods are customer-scoped (`customerRef`), saved explicitly via `saveMethod`, and returned as `savedMethodId` once a payment succeeds, so they serve one-click upsells and renewals alike. Off-session charges may return `requires_action` (SCA) or `failed`; dunning retries and "update payment method" flows are the future subscription module's job, using the same states.
- Missing for subscriptions and intentionally not added: mandate/consent records, plan/price objects, proration. Those belong to Phase 8 and need no interface change here, only additions.

## Consequences

- Adapters implement seven methods; the Stripe adapter (2.3) maps PaymentIntents onto these states and passes `paymentConformance` in test mode.
- The saga (3.x) must dedupe webhooks by `event.id`, gate updates with `PAYMENT_STATE_TRANSITIONS`, and reconcile via `retrieve` for non-manual providers.

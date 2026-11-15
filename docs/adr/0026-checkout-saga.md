---
status: accepted
---
# `completeCheckout` saga

Task 2.7 (🔒). `createCheckout` in `packages/core/src/saga/checkout.ts`, on the runner of ADR 0010. No new dependency in `core`.

## Steps

`reserve-stock` → `redeem-discount` → `create-payment` → `await-payment` (30 min) → `create-order`. Each step has a compensation (release holds, release redemption, refund if captured). Failure of the step itself also runs its compensation with no result (ADR 0010).

- **Run id** derives from the cart id and an `attempt` number (`runIdFor`), so a double submit or second tab is the same run: one payment, one order. Attempt n+1 (retry after a decline) starts only once attempt n is `compensated`. Reservation and order ids derive from the run id, so a re-driven step finds its own rows.
- **The saga prices the cart itself** (`cartTotals` plus the discount code via `applyDiscount`). `CheckoutInput` has no total; `adjustments` (shipping, tax) are server-resolved values that task 2.8 must never take from the client. The order and the payment use the computed total.
- **Order after payment** (ADR 0003): payment is created with automatic capture; `create-order` runs only once the provider's *current* state (`retrieve`) is `captured` for exactly the expected amount. The webhook is only a trigger, so out-of-order or forged-but-signed payloads cannot create an order.
- **One transaction** commits stock, saves the order (digital and `none` lines auto-fulfilled via `settle`, consents and `paymentId` recorded), queues `order.created`/`order.paid` and runs the optional `grantDownloads` hook. It uses only the transaction-bound repositories (memory adapter caveat). A failure rolls everything back, then the payment step refunds.
- **Webhooks**: `onPaymentEvent` acts only on terminal states (`captured`, `failed`); the saga records `event.id` as the wait result, so later deliveries of any event for a finished run are no-ops. `reconcile(runId)` (also run by `start`; for the 2.11 sweeper) resumes a paused run whose payment settled and refunds a captured payment of a run that already gave up. A capture arriving while the run is `compensating` is refunded too. `failed` is final for the run: a customer retrying the same provider payment later is refunded, not given an order.
- **No void in the provider interface** (ADR 0022): an abandoned payment cannot be cancelled; it expires at the provider. If it is captured after the run gave up (timeout, failure), `onPaymentEvent` refunds it with the same key and amount as the compensation refund, so replays collapse.
- `clientSecret` is never persisted: the run stores only the payment id; the client fetches the action with `payments.retrieve`.

## Decisions and limits

- Ports the app supplies: `variantOf`, `runIdOf` (payment id → run id; webhooks carry no reference), `nextOrderNumber(tx)` (gap-free numbering belongs with task 2.12), optional `grantDownloads(tx, order)` (task 2.10).
- A cart edited since the customer saw prices (`cartUpdatedAt`) is refused.
- Record the payment-id → run-id mapping (`runIdOf`) right after `start` returns; a webhook that wins the race is dropped until `start` or `reconcile` runs again.
- Deferred: if the cart is edited between a failed `reserve-stock` and its compensation, holds for added lines are not released by id and lapse at their TTL (35 min). The memory adapter's `transaction()` overwrites writes made through the outer repositories while it is open (test-only; the saga uses `tx` throughout).
- `Order` gains optional `paymentId` and `consents`.
- Zero-total (free) checkouts are not supported yet (`assertChargeable` rejects 0).
- The cart is not locked; one live attempt per cart is enforced by the run id.
- Stale-revision errors from racing webhooks propagate; the handler maps them to a retry (ADR 0010).
- Tests live in `adapter-memory` (core cannot depend on it): a property test injects a failure at each step and asserts the acceptance invariants (stock, orders, events, refunds equal captured); `fast-check` is added there as a dev dependency already used by `core`.

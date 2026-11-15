---
status: accepted
---
# `completeCheckout` saga

Task 2.7 (🔒). `createCheckout` in `packages/core/src/saga/checkout.ts`, on the runner of ADR 0010. No new dependency in `core`.

## Steps

`reserve-stock` → `redeem-discount` → `create-payment` → `await-payment` (30 min) → `create-order`. Each step has a compensation (release holds, release redemption, refund if captured). Failure of the step itself also runs its compensation with no result (ADR 0010).

- **Run id** is a `chk_` id per attempt (the API maps its idempotency key to it, ADR 0019). A retry after a decline is a new attempt. Reservation and order ids derive from the run id, so a re-driven step finds its own rows and a double submit yields one order.
- **Order after payment** (ADR 0003): payment is created with automatic capture; `create-order` runs only once the provider's *current* state (`retrieve`) is `captured` for exactly the expected amount. The webhook is only a trigger, so out-of-order or forged-but-signed payloads cannot create an order.
- **One transaction** commits stock, saves the order (digital and `none` lines auto-fulfilled via `settle`, consents and `paymentId` recorded), queues `order.created`/`order.paid` and runs the optional `grantDownloads` hook. It uses only the transaction-bound repositories (memory adapter caveat). A failure rolls everything back, then the payment step refunds.
- **Webhooks**: `onPaymentEvent` acts only on terminal states (`captured`, `failed`); the saga records `event.id` as the wait result, so later deliveries of any event for a finished run are no-ops. `reconcile(runId)` repairs a dropped webhook (also run by `start`), for the 2.11 sweeper.
- **No void in the provider interface** (ADR 0022): an abandoned payment cannot be cancelled; it expires at the provider. If it is captured after the run gave up (timeout, failure), `onPaymentEvent` refunds it with the same key and amount as the compensation refund, so replays collapse.
- `clientSecret` is never persisted: the run stores only the payment id; the client fetches the action with `payments.retrieve`.

## Decisions and limits

- Ports the app supplies: `variantOf`, `runIdOf` (payment id → run id; webhooks carry no reference), `nextOrderNumber(tx)` (gap-free numbering belongs with task 2.12), optional `grantDownloads(tx, order)` (task 2.10).
- `total` comes from `cartTotals`; the saga refuses a cart edited since (`cartUpdatedAt`) but does not recompute prices.
- `Order` gains optional `paymentId` and `consents`.
- Zero-total (free) checkouts are not supported yet (`assertChargeable` rejects 0).
- One order per attempt, not per cart; the cart is not locked.
- Stale-revision errors from racing webhooks propagate; the handler maps them to a retry (ADR 0010).
- Tests live in `adapter-memory` (core cannot depend on it): a property test injects a failure at each step and asserts the acceptance invariants (stock, orders, events, refunds equal captured); `fast-check` is added there as a dev dependency already used by `core`.

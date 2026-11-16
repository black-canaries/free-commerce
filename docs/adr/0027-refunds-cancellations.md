# 0027 Refunds and cancellations

Status: accepted (task 2.8)

- **One service, `createRefunds`** (core): refund (partial or full) or cancel, with optional per-line restock. Cancel = refund the remainder, then lifecycle `cancelled` (the existing guards still refuse cancelling a fully fulfilled order, e.g. digital-only: refund it instead).
- **Order of effects:** validate everything (amount, restock plan, state transition) → provider refund (idempotency key `<orderId>:refund:<key>`) → one transaction (order, stock, outbox, audit, download revocation). A failure before the provider call moves nothing; a failure after it rolls the transaction back and the same call retries, reusing the provider's refund. A `failed` provider refund aborts; `pending` is accepted.
- **Idempotency:** applied admin keys are stored on `Order.refunds`; a replay returns the order unchanged.
- **Schema (optional fields, no migration):** `OrderLine.variantId` (needed to restock; set by checkout, absent on older lines, which then cannot be restocked), `OrderLine.restocked`, `Order.refunds`.
- **Restock** only for managed variants, never above `quantity - restocked`. It reads then writes `StockLevel` inside the transaction; a strictly atomic increment would need a new `InventoryRepository` method (left for review: concurrent restock + sale of one variant could lose an update on Postgres).
- **Download grants:** `revokeDownloads(tx, order)` port, called when the order ends up `refunded` or `cancelled`; task 2.10 supplies it.
- Events `order.refunded` / `order.cancelled`; audit entry per action (actor supplied by the caller).

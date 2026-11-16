# 0027 Refunds and cancellations

Status: accepted (task 2.8)

- **One service, `createRefunds`** (core): refund (partial or full) or cancel, with optional per-line restock. Cancel = refund the remainder, then lifecycle `cancelled` (the existing guards still refuse cancelling a fully fulfilled order, e.g. digital-only: refund it instead).
- **Order of effects:** validate everything (amount, restock plan, state transition) → provider refund (idempotency key `<orderId>:refund:<key>`) → one transaction (order, stock, outbox, audit, download revocation). A failure before the provider call moves nothing; a failure after it rolls the transaction back and the same call retries, reusing the provider's refund. A `failed` provider refund aborts; `pending` is accepted.
- **Idempotency:** `Order.refunds` stores a fingerprint (key + amount, cancel, restock) per applied action; a replay returns the order unchanged, the same key with different content is `key_reused`.
- **Schema (optional fields, no migration):** `OrderLine.variantId` (needed to restock; set by checkout, absent on older lines, which then cannot be restocked), `OrderLine.restocked`, `Order.refunds`.
- **Restock** only for managed variants, never above `quantity - restocked`. It reads then writes `StockLevel` inside the transaction. That is safe because every `Database.transaction` is serialised (global advisory lock on Postgres, queue in memory), so concurrent refunds, and refund vs checkout commit, cannot interleave; the testkit runs concurrent refunds on both adapters. Only a bare `setStock` outside a transaction can race.
- **Concurrency:** the pre-check before the provider call may be stale; the in-transaction re-check on the fresh order is the authority, and the provider caps total refunds at captured.
- **Known gap:** a `pending` (asynchronous) provider refund is recorded as refunded; a later failure is not reconciled yet (payment reconciliation, task 2.11).
- **Out of core:** permission (`orders` write) and taking `actor` from the session belong to the admin route (task 1.14 or later). Cancelling an unpaid order releases nothing here: orders are created only after payment, and the saga releases holds.
- **Download grants:** `revokeDownloads(tx, order)` port, called when the order ends up `refunded` or `cancelled`; task 2.10 supplies it.
- Events `order.refunded` / `order.cancelled`; audit entry per action (actor supplied by the caller).

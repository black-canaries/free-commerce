---
status: accepted
---
# An Order exists only after payment succeeds (or staff draft it)

The checkout saga keeps in-flight state on the Cart and a Payment session (stock reserved, paused on 3DS, redirect or async payment). The Order is created when payment succeeds, so `requires_action` and `failed` Orders never appear in the merchant's list, and the Cart id is the single idempotency point for late, duplicate or early webhooks. Staff draft orders are the only Orders that exist before payment.

## Considered Options

Creating the Order at payment start (Medusa/Shopify style) was rejected: it pollutes the order list and splits idempotency between cart and order.

## Consequences

- Payment status has no `authorized` or `captured`: v0.1 auto-captures and `authorized` stays inside the provider adapter.
- Order numbers are allocated at creation, so they are gap-free.

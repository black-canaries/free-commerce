---
status: accepted
---
# Order state machines

The Order has three independent statuses (domain model). Entity schemas live in `packages/schema/src/order.ts`; transition rules are pure functions in `packages/core/src/orders/machines.ts`. They return `{ ok, order } | { ok: false, error: { machine, from, to, reason } }`; nothing throws, inputs are never mutated.

## States and allowed transitions

- **Lifecycle** `draft | open | completed | cancelled`: `draft → open | cancelled`, `open → completed | cancelled`. Guards (fulfilment is derived from lines, not trusted from the stored field): `completed` needs payment captured and all lines fulfilled (normally reached automatically); `cancelled` needs payment `unpaid | failed | refunded` (no stranded money, no in-flight payment) and fulfilment not `fulfilled`.
- **Payment** `unpaid | requires_action | pending | paid | partially_refunded | refunded | failed`: `unpaid → requires_action | pending | paid`, `requires_action → pending | paid | failed`, `pending → paid | failed`; refunds: `paid | partially_refunded → partially_refunded | refunded`. `failed` and `refunded` are terminal (a retry is a new PaymentSession). Drafts can be marked paid (a paid draft completes when opened if fully fulfilled); `completed` and `cancelled` orders cannot change payment. Refund states are reached only through `refundOrder(order, amount)` (not in `PAYMENT_TRANSITIONS`), which picks `refunded` when the total refunded equals paid.
- **Fulfilment** `unfulfilled → partially_fulfilled → fulfilled`, derived from `OrderLine.fulfilled` (no table: it cannot move backwards), never set directly. `fulfil` adds quantities to physical lines and needs an open order with captured payment.

## Derived rules (`settle`, idempotent, run after every change)

1. Once payment is captured (`paid | partially_refunded`), digital and `none` lines are fulfilled in full.
2. An `open`, captured, fully fulfilled order becomes `completed`.
3. Cart-born Orders are created already `paid`: the saga builds the Order and calls `settle`.

## Where invariants live

- Schema (`Order`): integer Money, one currency, `refunded <= paid`, `fulfilled <= quantity`.
- Core: no combined illegal state is reachable (completed ⇒ captured and fulfilled; cancelled ⇒ not fulfilled; fulfilment progress ⇒ captured unless cancelled; refunds never exceed paid). A property test over random command sequences checks these, plus table-driven legal/illegal matrices per machine.
- Precondition: callers pass `Order.parse`d data (unique line ids, `total` matching lines is the caller's job); the functions reject only what a transition itself depends on (e.g. a negative total on capture).
- Not here: stock restock, grant revocation, credit notes, `updatedAt` and timeline writes. The caller (service layer, saga) does those from the returned order. The timeline-event schema (notes, customer messages, status changes) lands with its first consumer, not here.

## Consequences

- `core` gains a workspace dependency on `@free-commerce/schema` (types only; no external runtime dependency) and `fast-check` as a dev dependency for the property tests (already approved in ADR 0008).
- A fully refunded order with unfulfilled physical lines stays `open` until cancelled; an order can be cancelled after partial fulfilment plus a full refund, and `fulfil` needs an `open` order (stock is the caller's concern).
- Refund allocation per line and tax breakdowns are out of scope (1.10+).

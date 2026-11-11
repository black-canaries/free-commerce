---
status: accepted
---
# Order state machines

The Order has three independent statuses (domain model). Entity schemas live in `packages/schema/src/order.ts`; transition rules are pure functions in `packages/core/src/orders/machines.ts`. They return `{ ok, order } | { ok: false, error: { machine, from, to, reason } }`; nothing throws, inputs are never mutated.

## States and allowed transitions

- **Lifecycle** `draft | open | completed | cancelled`: `draft → open | cancelled`, `open → completed | cancelled`. Guards: `completed` needs payment captured and fulfilment `fulfilled` (normally reached automatically); `cancelled` needs payment `unpaid | failed | refunded` (no stranded money, no in-flight payment) and fulfilment not `fulfilled`.
- **Payment** `unpaid | requires_action | pending | paid | partially_refunded | refunded | failed`: `unpaid → requires_action | pending | paid`, `requires_action → pending | paid | failed`, `pending → paid | failed`, `paid → partially_refunded | refunded`, `partially_refunded → partially_refunded | refunded`. `failed` and `refunded` are terminal (a retry is a new PaymentSession). Anything past `unpaid` needs an `open` order. Refund states are reached only through `refundOrder(order, amount)`, which picks `refunded` when the total refunded equals paid.
- **Fulfilment** `unfulfilled → partially_fulfilled → fulfilled`, derived from `OrderLine.fulfilled`, never set directly. `fulfil` adds quantities to physical lines and needs an open order with captured payment.

## Derived rules (`settle`, idempotent, run after every change)

1. Once payment is captured (`paid | partially_refunded`), digital and `none` lines are fulfilled in full.
2. An `open`, captured, fully fulfilled order becomes `completed`.
3. Cart-born Orders are created already `paid`: the saga builds the Order and calls `settle`.

## Where invariants live

- Schema (`Order`): integer Money, one currency, `refunded <= paid`, `fulfilled <= quantity`.
- Core: no combined illegal state is reachable (completed ⇒ captured and fulfilled; cancelled ⇒ not fulfilled; fulfilment progress ⇒ captured unless cancelled; refunds never exceed paid). A property test over random command sequences checks these, plus table-driven legal/illegal matrices per machine.
- Not here: stock restock, grant revocation, credit notes, timeline writes. The caller (service layer, 1.9/saga) does those from the returned order; `TimelineEvent` in the schema covers notes, customer messages and status changes.

## Consequences

- `core` gains a workspace dependency on `@free-commerce/schema` (types only; no external runtime dependency) and `fast-check` as a dev dependency for the property tests (already approved in ADR 0008).
- A fully refunded order with unfulfilled physical lines stays `open` until cancelled; partial fulfilment of a cancelled order is allowed (stock is the caller's concern).
- Refund allocation per line and tax breakdowns are out of scope (1.10+).

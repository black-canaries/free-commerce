---
status: accepted
---
# Event bus and transactional outbox

Task 2.1. Domain changes publish events that email, webhooks (2.13) and automations consume, without a failed subscriber ever rolling back or losing the change.

## Decisions

- **Outbox is a repository** (`Repositories.outbox`: `add`, `pending`, `markDelivered`). Called through `Database.transaction`, the event commits or rolls back with the domain change; no dual write. `add` is idempotent by event id; `pending` is insertion order. Memory keeps a Map (insertion order); Postgres a `outbox` table (`seq bigserial` for ordering, `id` unique, JSONB event, `delivered_at`, partial index on undelivered) with its own forward-only migration folder.
- **In-process bus** (`createEventBus`): `subscribe(type, handler)`, `publish` runs all handlers for the type and rejects with the first error after all have run, so one broken subscriber does not starve the others. Pure core, no I/O.
- **Relay is a function, not a daemon**: `relayOutbox(outbox, bus, batch)` publishes pending events in order and marks each delivered afterwards. The scheduler tick (2.11) or a request hook calls it; no timers in core.
- **At-least-once**: a handler failure stops the batch (order preserved), leaves the event pending and rethrows; a crash between publish and mark redelivers it. Subscribers with side effects must be idempotent: `idempotent(seen, handler)` dedupes on the stable `event.id`; `seen` must be as durable as the effect (ideally written in the same transaction as the effect).
- Multiple relays are safe but may deliver an event twice (same contract); no row locking.
- Shared testkit cases (`outboxConformance`) cover ordering, duplicates, rollback, mid-batch failure and crash-before-mark on both adapters.

## Consequences

- **Head-of-line blocking**: a permanently failing event blocks later ones until fixed. No attempt counter or dead-letter yet; 2.11 (jobs, retries) and 2.13 (per-endpoint retries/backoff) add them when a real consumer needs it.
- Delivered rows are never purged; a retention sweep belongs with the 2.11 sweepers.
- Event payload schemas are defined by each emitting module (`payload: unknown` here).

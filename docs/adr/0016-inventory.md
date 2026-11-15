---
status: accepted
---
# Inventory: stock levels and expiring reservations behind an atomic repository

**Model** (`packages/schema/src/inventory.ts`): `StockLevel` = on-hand `quantity` per variant (negative only when backordered units were committed). `Reservation` = variant, cart, positive quantity, `expiresAt`, status `active | committed | released`. Reservation ids are `rsv_...`.

**Service** (`packages/core/src/inventory/`): `createInventory(repo, now)` with an injected clock (no `Date.now` in logic). Only variants with `manageInventory` reserve; digital and `none` return `unmanaged` and touch nothing. `allowBackorder` on the variant lets a reserve succeed beyond stock. `available = onHand - reserved(now)`.

**Expiry is read-time**: a reservation counts only while `active` and `expiresAt > now`, judged inside `reserved`/`reserve`. Nothing mutates on expiry; the sweeper (2.11) is housekeeping only. An expired reservation cannot be committed (its units may have been sold) but can be released.

**Atomicity (required of every adapter)**: `InventoryRepository.reserve` and `settle` are single atomic operations, serialised per variant, so concurrent reserves can never oversell and a commit can never double-consume. We chose atomic repository operations over `transaction()` in the service: the check-then-write needs a row lock in SQL anyway, and one method per operation keeps the contract storage-agnostic. Postgres (1.7): one DB transaction under a per-variant advisory lock (works when the stock row does not exist yet), sums active unexpired reservations, then inserts; `settle` takes the same lock, applies `decideSettle`, and decrements stock in the same transaction.

**Postgres (1.7 adapter)**: real columns in the `inventory` migration module (`stock`, `reservations`, `expires_at timestamptz`). `reserve` and `settle` each run in a transaction holding `pg_advisory_xact_lock(hashtextextended(variant_id))`, so the check-then-write is serialised per variant under READ COMMITTED; commit upserts `stock` in the same transaction. The same testkit cases and properties run against it in CI.

**State machine** (`decideSettle`, shared by adapters so behaviour cannot drift): settling to the current state is a no-op success (idempotent by reservation id); `committed` and `released` are final, so commit-after-release and release-after-commit are `conflict`; unknown id is `not_found`; commit after expiry is `expired`. `reserve` with an existing id is decided by the shared `decideReserveRetry`: it returns the stored reservation only while it is active, unexpired and identical in variant, cart and quantity; anything else is `conflict` (never a silent "reserved" for a released, expired or different hold). `ttlMs` must be a positive integer; `setStock` parses `StockLevel`.

**Tests**: conformance cases and fast-check properties (no oversell under concurrent `Promise.all`, expired never count, commit/release settle once, digital and `none` never reserve) live in `adapter-testkit` so Postgres runs the same ones. New devDependency-style use of `fast-check` (already approved, already in `schema`) in `adapter-testkit`; `adapter-memory` and `adapter-postgres` gain a workspace-only dependency on `schema` for types.

## Consequences

- Memory adapter's atomicity comes from synchronous bodies on the event loop; `Database.transaction` copies state, so inventory calls made on the outer repositories while a transaction is in flight are lost on commit. Checkout must call inventory outside `transaction()` (the saga does) (the Postgres adapter is safe either way).
- Missing stock row means 0 on hand: a managed variant is unsellable until stock is set.
- No per-cart reservation lookup or sweeper yet; add them when 2.x needs them.

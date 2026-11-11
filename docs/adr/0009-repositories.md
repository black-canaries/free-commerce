---
status: accepted
---
# Repositories, transactions and the adapter testkit

**Interfaces** (`packages/core/src/repositories.ts`, interfaces only): one generic `Repository<T extends {id}>` with `get` (null when missing), `save` (upsert) and `list` (ordered by `id`, `PageQuery` cursor in, `{items, nextCursor}` out). `ProductRepository`, `CartRepository`, `OrderRepository` are aliases of it with a placeholder `Entity` default; Phase 1 narrows the generics to the real schemas and adds query methods only when a task needs them. Core imports `PageQuery` as a type from `@free-commerce/schema` (workspace dependency, no new third-party dependency).

**Transactions**: `Database` = the three repositories plus `transaction(fn)`. `fn` receives transaction-bound repositories; resolve commits everything, throw persists nothing and rethrows. No nesting, no savepoints; callers must not touch the outer repositories inside `fn`. Postgres maps this to a single DB transaction.

**Testkit**: `@free-commerce/adapter-testkit` exports `repositoryConformance(name, makeDatabase)` registering Vitest cases (round trip, missing, pagination, commit, rollback on throw), mirroring ADR 0007's provider conformance. Every adapter, in-memory included, runs it from its own package.

**In-memory adapter** (`@free-commerce/adapter-memory`): Maps with structured-clone isolation; a transaction runs serially on a copy of the state that replaces it on success. Rejected: a lock-free copy-on-write without serialisation (concurrent transactions lose updates).

## Consequences

- Cursor is the last returned `id`; adapters may change the encoding since cursors are opaque, but ordering by `id` is part of the contract.
- Adding an aggregate means one line in `Repositories` and in the testkit's list.

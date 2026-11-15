---
status: accepted
---
# Postgres adapter: Drizzle, JSONB documents, per-module migrations

Task 1.7. `@free-commerce/adapter-postgres` implements `Database` (ADR 0009) and passes `repositoryConformance`, run from the same test file shape as the in-memory adapter.

## Decisions

- **Driver: `postgres` (postgres.js) 4.1.1** (new runtime dependency, this package only). Zero dependencies, pure JS over TCP sockets, runs on Node, Bun and Cloudflare (via `cloudflare:sockets`), first-class Drizzle driver, built-in `begin()` transactions. `pg` is larger, Node-first and needs a pool shim on edge. **`drizzle-orm` 0.45.4** (new runtime dependency, mandated by the stack in CLAUDE.md) is used for the query builder only. `drizzle-kit` is **not** added: the schema is three identical two-column tables, so hand-written SQL migrations are shorter than generator config, and the conformance suite fails if SQL and Drizzle schema drift.
- **Aggregates are JSONB documents**, one table per module: `<module>(id text collate "C" primary key, doc jsonb not null)`. Zod schemas stay the single source of truth (no second column-level model to keep in sync), saving/loading an aggregate is one row (no multi-table assembly), and the aggregate is the transaction boundary anyway. `collate "C"` makes ordering by `id` bytewise, identical to the in-memory adapter's string sort, so cursor pagination (`id > cursor order by id limit n+1`) is stable and index-backed. Search and filtering (tasks 2.x) add expression indexes or generated columns in a later per-module migration, with no change to stored data; entities that need relational integrity (inventory counters, 1.3) get real columns in their own module. Rejected: normalised tables per aggregate (large, premature, duplicates the schemas).
- **Migrations per module, forward-only**: `migrations/<module>/NNNN_name.sql`, applied in module then name order by `migrate(client, dir?)` (`@free-commerce/adapter-postgres/migrate`, Node-only, kept out of the edge-safe entry point). Each file runs in its own transaction with an advisory lock and is recorded in `_migrations(module, name)`; re-running and concurrent runners are safe. No down migrations. **Upgrade harness** (`migrate.test.ts`): apply the previous release's migration set to a scratch schema, insert data, apply the next set, assert data survived and re-run is a no-op. For each release add the new file and extend the test.
- **Transactions**: Drizzle `transaction` over a single postgres.js connection; the callback receives repositories bound to it, throw rolls back and rethrows. Each transaction first takes `pg_advisory_xact_lock`, so transactions run one at a time like the in-memory adapter. This keeps read-modify-write (inventory reservations, 1.3) free of lost updates under READ COMMITTED without retry logic, at the cost of write throughput; acceptable for a one-store deployment, and per-aggregate locking can replace it later without an interface change. The testkit's concurrency case enforces the behaviour on every adapter. Plain `save`/`get` outside a transaction are single statements.
- **No leakage through `core`**: the adapter imports only `core` types; `createPostgresDatabase(client)` takes a postgres.js client the caller owns; nothing Drizzle or SQL appears in `Repository`, `Database` or cursors (a cursor is the last `id`).
- **Adding a repository** (e.g. inventory): one entry in `tables`, one line in `bind`, one `migrations/<module>/0001_init.sql`, one aggregate in the testkit.
- **Testing**: set `TEST_DATABASE_URL` (locally `docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine`). Without it the suite skips with that hint, so offline `pnpm test` stays green; when `CI` is set and the URL is missing the suite throws, and the CI job provides a Postgres service container, so it cannot be skipped there. Turbo passes both variables to `test`.

## Consequences

- The testkit's `make` may now return a promise (the Postgres factory migrates and truncates).
- Stored documents are whatever the aggregate serialises to; incompatible schema changes need an explicit data migration in that module's folder.
- Whole-table `truncate` in tests means the test database must be disposable.

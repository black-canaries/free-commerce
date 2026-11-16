---
status: proposed
---
# Repository interface review: no SQL leakage in types; Convex fit and recommended changes

Task 1.8. Reviewed `packages/core/src/repositories.ts`, `AuditRepository`, `Outbox`, `SearchProvider`, and the Postgres adapter (ADR 0017). Interfaces are **not** changed here (CLAUDE.md: stop and ask once the testkit exists); changes are recommendations for Jon to approve.

## Leakage review

Types and signatures are clean: no Drizzle/SQL types, no table or column names, no query objects, no SQL-shaped filters (`where`, joins, `limit/offset` numbers). Cursors are opaque strings. Money is integers, times are ISO strings, ids are strings. Findings:

1. **Doc comments name SQL mechanisms** (`SELECT ... FOR UPDATE`, advisory lock) in `InventoryRepository` and `DiscountRepository`. Behaviour is specified correctly (atomic, serialised per variant/code); the SQL is only an example. Wording only.
2. **`Repository.list` orders by `id` ascending** and ADR 0009 says the cursor is the last `id`. Ordering by `id` is a real contract (the testkit asserts it); the cursor encoding is not. Fine, but every adapter must have an `id`-ordered index.
3. **`transaction(fn)` takes an arbitrary async callback** that interleaves reads and writes. This maps to a Postgres connection transaction, not to every store (see Convex). Its contract does not say whether `fn` may be re-run or may do external I/O.
4. **Offset cursors in `SearchProvider`** (`offsetOf`) are an implementation choice, not an interface rule (the cursor is opaque), so not a leak. Search is already a separate provider, which is right.
5. **`AuditEntry.before/after: unknown`** stores arbitrary JSON; stores with key restrictions must sanitise (below).

## What a Convex adapter would need

Convex has no connection-level transactions: each mutation is one serialisable transaction (optimistic concurrency, auto-retried on conflict), and queries and mutations cannot call external services.

- **Documents**: one table per module, `{ id: string, doc: any }` (or Zod-derived validators), index `by_id` on `id`. Convex's own `_id` is unused; `list` pages `by_id` with `paginate`/`take` and an opaque cursor. Same JSONB-document approach as ADR 0017. Limits: 1 MiB per document, about 16k docs read per mutation, so a `list` page must stay small.
- **Transactions (the hard part)**: `Database.transaction(fn)` cannot be implemented from outside Convex, because a client cannot hold a transaction open across calls. Two workable shapes: (a) run `core` use-cases *inside* Convex mutations, where `Database` wraps `ctx.db` and `transaction(fn)` just runs `fn` (the mutation is the transaction); core is pure TypeScript, so this works, but each use-case must be a single mutation and saga steps with provider I/O stay in actions; (b) one mutation per repository method, with no cross-repository atomicity (unacceptable for outbox and order writes). Recommend (a).
- **Retry semantics**: Convex re-runs a mutation on conflict, so `fn` may execute more than once. It must be free of external I/O and non-deterministic side effects. Core already keeps saga I/O outside `transaction`; this should be written into the contract.
- **Atomic methods** (`reserve`, `settle`, `redeem`): free under serialisable isolation (read, check, write in one mutation); no explicit locking needed. Concurrency testkit cases should pass.
- **Uniqueness** (`DiscountRepository.save` rejecting a duplicate `code`, `Outbox.add` idempotent by id): Convex has no unique constraints; check by index inside the mutation (safe, since serialisable).
- **Outbox `pending(limit)`** in insertion order: index on `_creationTime`/a sequence; delivery runs as a scheduled action calling `relayOutbox`.
- **Audit `before/after`**: Convex rejects field names starting with `$` or `_`; store as a JSON string or sanitise keys.
- **Search**: Convex search indexes support text plus equality filters but not offsets, range/array filters or facets like the Postgres provider; a Convex `SearchProvider` would fetch a bounded candidate set and filter in code, or defer to an external provider. Offset cursors are fine behind opacity.
- **Cost**: the Postgres adapter takes a global per-transaction advisory lock; Convex gets finer-grained OCC for free.

Verdict: a Convex adapter is feasible only via shape (a); the interfaces themselves need no signature change.

## Recommended changes (not applied; need approval)

1. Reword the SQL examples in `InventoryRepository` and `DiscountRepository` docs to be store-neutral (comment-only; zero risk).
2. Add to the `Database.transaction` doc: `fn` may be retried and MUST NOT perform external I/O or non-idempotent side effects; nesting unsupported (already stated).
3. State in the `Repository.list` doc that adapters need an `id`-ordered index and pages are bounded (cap `PageQuery.limit`; check schema).
4. Freeze: once 1 to 3 are approved, mark the interfaces frozen for v0.1. A testkit case for `fn` re-execution is not worth adding until a Convex adapter is planned.

## Consequences

- No code or interface changes in this PR; item 1 to 3 are comment-only follow-ups.
- Convex support stays a post-v0.1 option with a known cost: core must run inside Convex mutations.

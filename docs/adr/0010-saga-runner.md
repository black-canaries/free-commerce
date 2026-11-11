---
status: accepted
---
# Saga runner: persisted-record, event-resumed, no timers

Checkout is a code-defined, resumable saga with compensation (brief rule 6). `packages/core/src/saga/runner.ts` is the in-house runner (brief: no Temporal/Inngest). Spike scope; the Postgres `SagaStore` arrives with task 0.9 adapters.

## Step model

A `Saga<I>` is a named, ordered list of steps. A step is either an **action** (`run(ctx)`, optional `compensate(ctx, result)`, optional `retries`) or a **wait** (`waitFor: {event, timeoutMs}`). `ctx` carries the saga input, the recorded results of earlier steps by name, and an idempotency `key`. Results must be JSON-serialisable. Steps are straight-line; branching belongs in the step body. A failed step is not itself compensated (it is assumed atomic or idempotent via its key); every earlier *completed* step is, in reverse order.

## Persistence and resume

The whole run is one JSON record (`SagaRun`: status, per-step result and `compensated` flag, `waiting`, `error`) saved through an injected `SagaStore` after each step. Nothing lives in memory between calls, so a run survives restarts:

- `start(saga, runId, input)` is idempotent: a new id creates the run; an existing `running`/`compensating` run is re-driven (crash recovery); terminal or paused runs are returned unchanged. Recorded steps are never re-executed.
- `resume(saga, runId, event, payload)` is called by the verified, idempotent webhook handler. It records the payload as the wait step's result and continues. Duplicate, wrong-event or already-finished deliveries are no-ops.
- `expire(saga, runId)` is called by a sweeper (the reconciliation job / scheduler tick); it compensates a paused run past its deadline.
- Optimistic concurrency: every save bumps `rev`; stores must reject a save unless `rev === stored.rev + 1`. Two racing resumes therefore cannot both proceed past a save; the loser throws and the caller retries (and then sees the no-op path).

## Idempotency

`key = <runId>:<stepName>` (`...:compensate` for undo) is identical across retries and restarts. Providers receive it as their idempotency key, so a step that crashed after its side effect but before its result was recorded is safe to run again. The runner itself only skips steps already recorded.

## Retries

`retries: n` gives n extra attempts, only when the error is a `ProviderError` with `retryable` (ADR 0007). Any other error fails the step immediately. No backoff: the runner has no timers; delayed retry is a scheduler concern.

## Timeout semantics

Deadline = `now() + timeoutMs` at pause, with `now` injected (default `Date.now`). It is enforced lazily: a late `resume` or an `expire` call past the deadline compensates; no timer fires by itself. Consequently a run with no sweeper stays paused until its event arrives. Compensation failures do not stop the remaining compensations; the run ends `compensation_failed` with all errors in `error` for manual repair. A crash mid-compensation leaves `compensating`; `start` resumes it, skipping undo steps already flagged done.

## Tracer

`Tracer`/`Span` are structural subsets of OpenTelemetry's API (`startSpan(name, {attributes})`, `end`, `setStatus({code})`, `recordException`), so an OTel tracer is injectable with no adapter. `@opentelemetry/api` is **not** a dependency of `core`; default is a no-op. One span per step execution (`saga.step`) and per compensation (`saga.compensate`) with `saga.run` and `saga.step` attributes; retries happen inside one span. Wait steps have no span.

## Consequences

- No new dependency. fast-check not added: failure-at-each-step is an exhaustive table, which a property test would not improve.
- Steps cannot be edited while runs are in flight: a run records step names, so renaming or reordering needs a new saga version (ADR when first needed).
- Whole-record saves are simple but write more than a step log; fine at checkout scale.
- Exactly-once is not claimed: steps are at-least-once with idempotency keys.

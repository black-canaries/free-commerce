---
status: accepted
---
# Server skeleton: Hono, middleware order, idempotency, rate limiting, tracing

`@free-commerce/server` exposes `createApp(deps)`: a Hono app built only on Web-standard APIs (`Request`, `Response`, `crypto`), so it runs on Node, Bun and edge. All I/O arrives through `deps` (DB check, stores, logger, tracer, clock); there is no `node:` import and no serve entry yet (each runtime wraps `app.fetch`).

## Decisions

- **Hono** (the only new runtime dependency, pre-approved in the brief): small, Web-standard, multi-runtime, no framework lock-in. Pinned to 4.13.14, the newest release past the repo's `minimumReleaseAge` gate. No `@hono/zod-validator`: `parse(schema, data)` is ten lines over Zod and yields our `ApiError` shape.
- **Middleware order**: request context (ID, span, log line) → rate limit → idempotency → handler, the last two on `/store/*` and `/admin/*` only. Rate limiting precedes idempotency so rejected traffic never touches the idempotency store. `/health` and `/ready` are unauthenticated and unlimited.
- **Errors**: handlers throw `HttpError(code, message, {details, headers})`; `onError` and `notFound` emit the schema's `ApiError` with `requestId`. Status per code is fixed in one table. Unknown errors become `internal` with a generic message; the stack goes to the log only.
- **Request ID**: inbound `x-request-id` is honoured if it matches `[\w.-]{1,128}`, otherwise a UUID is generated. It is echoed on the response, set on every log entry and the span (`request.id`).
- **Tracing**: a structural `Tracer { startSpan(name, attrs) → { setAttribute, end } }`, no-op by default. `@opentelemetry/api` is not added: an adapter over its `Tracer` is a few lines in the app that wants OTel, and the API package would otherwise ship in every deployment unused.
- **Idempotency**: required `Idempotency-Key` header on POST/PUT/PATCH/DELETE (missing → `validation_failed`). Fingerprint = SHA-256 of method, path, query and body. Same key + same fingerprint replays the stored status and body with `idempotent-replayed: true`; same key + different fingerprint → `idempotency_key_reuse` (422). 5xx responses are not stored so clients can retry. Store interface is `get`/`set`; inbound webhooks live outside these groups and dedupe by provider event ID instead.
- **Rate limiting**: `RateLimitStore.hit(key, windowMs) → {count, resetAt}`, fixed window per client (first `x-forwarded-for` hop, which the deployment proxy must set). Over the limit → `rate_limited` (429) with `Retry-After` seconds.
- **Env**: Zod-validated `loadEnv`; errors list variable names and reasons, never values. Only settings a real store changes: `DATABASE_URL`, `RATE_LIMIT_PER_MINUTE`.
- **`/ready`** returns 503 `{status:"unavailable"}` when `checkDb` rejects; the cause is logged, never returned.

## Consequences

- Concurrent requests with the same new key both run: `get`-then-`set` is not atomic. The Postgres store (with the DB adapters) must add an atomic claim (unique key + in-progress marker) before money-moving routes (checkout) rely on this; the interface change is cheap while only the fake exists.
- Keys are not yet scoped to an authenticated principal; scope them when auth (1.10) lands.
- In-memory stores are unbounded and per-process: tests and single-instance dev only.
- `checkDb` has no built-in timeout; the injected check owns it.

---
status: accepted
---
# API keys; idempotency scoped per principal and atomic

Task 1.10 (🔒).

## API keys (`core/auth/apikeys.ts`, pure)

- Two types: **publishable** (`pk_`, storefront: scopes `read`, `cart`) and **secret** (`sk_`, server integrations: any scope, including `admin:read`, `admin:write`). Publishable keys cannot be created with admin scopes; the server additionally refuses non-secret keys on `/admin`.
- Secret = 256 random bits (`crypto.getRandomValues`), shown once by `createApiKey`; only its SHA-256 is stored (`hash`) plus a 7-character `hint`. A fast hash is correct here because the input is high-entropy; password-style stretching adds nothing. Lookup is by hash, so there is no comparison to time.
- Verification happens on every request (`verifyApiKey`), so revocation is immediate. `rotateApiKey` issues a same-scope replacement and retires the old key after an optional grace period.
- Sent as `x-api-key`. `/store/*` requires a key whose scope covers the method (`read` for GET, `cart` for writes); `/admin/*` needs an admin session or a secret key with `admin:read`/`admin:write`.
- `ApiKeyStore` (get, getByHash, save) has an in-memory fake only. **The Postgres implementation, and management routes (create, list, rotate, revoke), are not in this task**: adding it to `Repositories` would change the repository interfaces after the testkit exists (stop-and-ask rule), so it is a follow-up with the DB adapters; until then production needs a store adapter.

## Idempotency fixes (closes the ADR 0011 caveats)

- **Scoped per principal**: the stored key is `<cus|adm|key>:<id>:<client key>`. One caller's key can neither replay nor block another's request. Anonymous callers share the scope of their publishable key, so a guessed key plus an identical body could replay an anonymous cart response: clients must use random keys (UUIDs).
- **Atomic claim**: `IdempotencyStore` is now `claim(key, fingerprint)` / `complete` / `release`. The first request owns the key; a concurrent duplicate gets `conflict` (409, `Retry-After: 1`) instead of running twice; 5xx and thrown errors release the key. A Postgres store must implement `claim` as an insert-if-absent and expire stale in-progress rows (a crash between claim and complete would otherwise block the key).

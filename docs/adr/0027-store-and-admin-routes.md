---
status: accepted
---
# Store and admin routes, API key persistence, uploads

Task 1.14 (🔒: auth, keys, personal data).

## Decisions

- **Routes are thin**: handlers parse with Zod (`parse`), call the core services (catalog, cart, inventory, order machines, API keys) and map domain errors to `ApiError` in one place (`fromDomain`). No business rule lives in a route. Mounted in `store.ts` and `admin.ts`; all `/admin/*` handlers sit behind the 1.11 chain (guard, `can`, idempotency, audit), so a route under an unmapped segment is 403. `digital-assets` is a new segment in `ADMIN_GROUPS` (catalog group).
- **Store**: `GET /store/products` (search; flat query: `option.<name>=a,b`, `priceMin`, `priceMax`), `GET /store/products/:id` (active only), carts (create, get, add/update/remove line, with derived totals), `GET /store/customers/me`, `GET /store/orders[/:id]`. Cart edits are one transaction (read-modify-write). The cart id (80 random bits) is the capability to edit it; a customer-bound cart comes with checkout routes. There is no customers repository yet (2.9), so `customers/me` is the session identity only.
- **Admin**: products (create, patch, publish, archive), stock per variant, orders (list, get, fulfil, complete), media and digital-asset upload/delete, API keys. Every product or stock change re-indexes search (eventually consistent, ADR 0025). Variant input is validated by core's `Variant` schema, not duplicated in a route schema (Zod 4 cannot omit fields of a refined schema); errors list every field. Cancel and refund are 2.8; collections have no repository yet; digital assets are stored objects only until 2.10 adds `DigitalAsset` and `DownloadGrant`.
- **API keys**: `ApiKeyStore` gains `list`; Postgres `createPostgresApiKeyStore` (JSON documents, table `api_keys`, **unique index on `doc->>'hash'`**) and the fake share one `apiKeyStoreConformance` suite. It is deliberately not part of `Repositories`/`Database` (keys are not domain data; no repository interface changes). Routes: create, list (never the hash), rotate (optional grace), revoke; owner-only through the permission table. Create and rotate responses carry the secret: the handler sets `sensitive`, and idempotency then stores a `409 conflict` instead of the body, so a replay never re-reveals it and the secret never rests in the idempotency store. Audit entries hold ids, type and scopes only. The key write and its audit entry are not atomic (separate stores); a failed append returns 500 after the key exists, which the owner sees in the list.
- **Uploads** (closes the ADR 0014 caller obligations): raw-body `POST /admin/media` and `/admin/digital-assets`; type sniffed from bytes (`validateUpload`), keys generated (`newStorageKey`). Size is capped **while streaming** by `hono/body-limit` before anything buffers the body (JSON bodies 1 MB, media 5 MB, assets 50 MB by default, `uploadLimits` to change); an oversized upload is 413 `validation_failed`. `GET /files/*` (enabled by `serveSigned`, e.g. `LocalStorage.getSigned`) answers with `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, a sandboxing CSP and `no-store`; the content type is the one sniffed at upload.

## Consequences

- The idempotency fingerprint still reads the whole body, so an upload is buffered once more (bounded by the cap); a streaming fingerprint is a later optimisation if the asset cap is raised a lot.
- A key's `hash` collision is impossible at the database level (unique index); `save` of a duplicate hash rejects.
- Public (unsigned) media serving is still deferred: media URLs are signed. Image variants remain deferred (ADR 0014).

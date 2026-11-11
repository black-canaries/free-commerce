---
status: accepted
---
# Storage providers: local-disk, S3-compatible, signed URLs, upload validation

Task 1.12 (🔒). Implements `StorageProvider` (ADR 0007) in two adapter packages; both pass `storageConformance`, now exported from `@free-commerce/core/testing`.

## Decisions

- **Everything is private.** The interface has no public-URL method; every read is a short-lived signed URL (max 7 days, the SigV4 limit; applied to both adapters). Public media serving (CDN or public prefix) is deferred to server task 1.14, which owns the HTTP surface; it needs no interface change to start.
- **Local disk** (`storage-local`, Node-only): URL = `base/<key>?expires=<s>&sig=<hex>`, `sig = HMAC-SHA256(secret, key + "\n" + expires)`. `getSigned(url)` is what the serving route (1.14) calls: it rejects foreign origin, malformed or traversal keys, expired, key-swapped, expiry-extended and bad signatures (constant-time compare, `node:crypto`) and returns `null`. Secret ≥ 32 chars, never in errors or logs. Content type is a sidecar file under a separate `type/` tree so user keys cannot collide with metadata. Objects live outside any web root.
- **S3/R2/MinIO** (`storage-s3`): path-style, SigV4 via **`aws4fetch` 1.0.20** (new runtime dependency, justified here). ~2 KB, fetch/WebCrypto only, so it runs on Node, Bun, Workers and RN-adjacent edge; the AWS SDK v3 is orders of magnitude larger and Node-oriented. We use only `sign()` and send through an injectable `fetch`, which also makes the tests MinIO-free. `signedUrl` does a HEAD first so a missing key is `not_found`, matching the interface.
- **Keys are generated, never user paths.** `isSafeKey` (core, pure) allows only `[A-Za-z0-9._-]` segments joined by `/`, no leading dot, no `..`, ≤512 chars; both adapters enforce it on every method. `newStorageKey(prefix, ext)` mints `prefix/<uuid>.<ext>`. The user's filename is metadata, never part of the key.
- **Upload validation** (`validateUpload`, core, pure): max size, allowed types by magic-byte sniffing (png, jpeg, gif, webp, pdf, zip); a declared type that disagrees with content is rejected. Lives in core because it is provider-independent and 1.14 needs it regardless of adapter; no I/O, no dependency. Types without a signature (text, csv) cannot be sniffed and are rejected until a caller needs them.
- **Image variants: deferred.** No `ImageVariantGenerator` interface now: with no implementation it would be speculative, and the sensible default (`sharp`) is a heavy native dependency that does not run on edge. Follow-up: add the interface together with the first implementation (likely sharp behind an optional package, or the CDN's image transform for R2/Cloudflare) when the storefront needs variants.
- **No upload endpoints** here (task 1.14).

## Consequences

- One new runtime dependency (`aws4fetch`), only in `storage-s3`; none in `core`.
- Local-disk is single-node: fine for dev and self-host on one box; use S3-compatible for anything multi-instance.
- Presigned S3 URLs cannot be revoked before expiry; keep TTLs short (download grants mint a fresh URL per request).

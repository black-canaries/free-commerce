---
status: accepted
---
# Provider conventions: interface, fake, config schema, error mapping, conformance

External services (payments, email, SMS, storage, search, auth, captcha) sit behind provider interfaces (brief rule 12). The pattern is a convention, not a framework: no base class, registry or DI container. Worked example: `StorageProvider` in `packages/core/src/providers/`.

Each provider `<x>` has:

- **Interface** (`<x>.ts`): the smallest set of methods core needs, in domain terms, `@experimental` until proven. Documents resolve-null vs throw behaviour.
- **Config schema** (`<x>.ts`): a Zod schema for the adapter's non-secret config; secrets come from env and are validated at startup, never logged.
- **Errors**: adapters throw only `ProviderError(provider, code, message, {cause})` with code `not_found | rejected | unavailable | unknown`. `retryable` is derived (`unavailable`), so the saga and retry logic never inspect vendor errors. Add a code only when a caller must branch on it.
- **Fake** (`<x>.fake.ts`): in-memory, deterministic (inject the clock), exported for tests; also the default for local demos.
- **Conformance** (`<x>.conformance.ts`): `<x>Conformance(name, make)` registers Vitest cases that every adapter, fake included, must pass. Real adapters run it in their own package (against a test-mode service where one exists).

## Placement

`packages/core`: providers are interfaces plus a pure-TS fake, with no I/O, which fits core's rules. Real adapters (S3, Stripe, Resend...) live in separate packages and depend on core. Alternative considered: a `packages/providers` package; rejected as an extra package with nothing to hold yet. Revisit if the fakes grow.

## Dependencies

Adds `zod` (pinned 4.6.7) to `core`, pre-approved as the settled stack for config and schemas. The conformance file imports `vitest` (root dev dependency); it is compiled but only imported from tests.

## Consequences

- Each new provider costs about four small files and nothing shared beyond `ProviderError`.
- Fake and conformance helpers are not yet exported from the package index (no consumer outside core exists); add a `/testing` subpath export when the first adapter package needs them.

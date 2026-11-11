---
status: accepted
---
# Schema dependencies: zod (runtime), fast-check (dev)

`@free-commerce/schema` takes `zod` v4 as its only runtime dependency: schemas are the single source of truth for types, validation and OpenAPI (brief), and validation is a correctness primitive we must not hand-roll. `fast-check` is a dev dependency for property-based tests of money allocation and later state machines, which the brief requires; example tests cannot show "never loses or invents a cent".

Related choices kept dependency-free on purpose: ISO 4217 codes are format-checked and only the non-2 minor-unit exponents are listed (a small documented table, no currency dataset); IDs are `prefix_` + ULID layout (48-bit ms time + 80 random bits, Crockford base32) built on the Web Crypto `getRandomValues` global, which exists on Node, Bun, edge and Expo, so the package stays React Native-safe.

## Consequences

- `zod` ships in every client bundle that imports `schema`; use `zod/mini` later if bundle budgets (3.1) demand it.
- Currencies with an unlisted non-2 exponent would be mis-scaled in display code; extend the table when added by ISO.
- `minorUnitExponent` is display-scoped. Providers may scale some currencies differently, so the payments task must use the provider's rules for amounts it sends.
- IDs sort by creation time only to the millisecond; order within one ms is random.

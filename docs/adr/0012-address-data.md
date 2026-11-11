---
status: accepted
---
# Address data: `@fragaria/address-formatter` + `postcode-validator`

Task 1.5 needs per-country postal-code validation, required fields and local line order from a maintained dataset, in a package safe for React Native and edge (no fs, no network). Lives in `@free-commerce/address` so `core` gains no dependency.

## Options

- **`@shopify/address`** (MIT, libaddressinput-derived): rejected. It fetches country data from a Shopify GraphQL endpoint at runtime: network dependency and a third party in the checkout path.
- **Google libaddressinput JSON directly**: data is fetched from a Google endpoint or vendored by hand; vendoring means we own the update process. Rejected as more code than the options below.
- **`@fragaria/address-formatter` 7.1.2** (MIT, released 2026-10): bundles the OpenCage address-formatting templates (CC0 data) per country; one runtime dependency (`mustache`). ~220 KB minified UMD, nearly all templates data. Formatting only.
- **`postcode-validator` 3.10.26** (MIT, released 2026-10): per-country postal-code regexes, no dependencies, ~32 KB. Validation only.
- Hand-written rules: forbidden by the brief.

Chosen: the last two together. `i18n-iso-countries` (stale since 2025-02, 620 KB) was not needed: country is validated by `postcode-validator`'s country list.

## How rules are derived (no hand-written per-country rules)

- Postal code: required and pattern-checked when `postcode-validator` has a pattern for the country; countries without one accept anything.
- Region: required when the country's address template prints it (probed by formatting with a sentinel region). US, JP, BR, CA, AU require it; GB, DE, FR do not.
- Output: `formatAddress` returns recipient, company, street, line2, then the template's city/region/postcode layout; the country name is left to the caller (localised).

## Consequences

- Both datasets are third-party regex/template snapshots; bump the two versions to pick up changes (pinned exact). Postal-code validity is format-only, not existence.
- Templates are Latin-script, OpenCage conventions: JP prints street before city/prefecture/postcode rather than the Japanese postcode-first order. Acceptable for the default path; revisit if Japanese-locale shipping labels matter.
- Required-region follows the template, which may differ from a carrier's rules in edge countries; the typed issue list (`field`, `code`) lets the UI explain.
- Measured with esbuild: 237 KB minified, 52 KB gzip for both libraries;  storefront bundles that only collect addresses should validate server-side via the SDK rather than import this package.

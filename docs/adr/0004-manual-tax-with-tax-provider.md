---
status: accepted
---
# Manual merchant-entered tax rates behind a `TaxProvider` interface

The brief forbids hand-rolling tax datasets, but v0.1 needs tax working. Merchants enter rates per country (and optional state) and tax category; inclusive or exclusive is set per country. There is no US sales-tax nexus or EU OSS logic. A `TaxProvider` interface (with a fake for tests) lets Stripe Tax or TaxJar plug in later. Docs state this is not tax advice.

## Consequences

- Merchants with complex obligations must wait for a provider implementation.
- Order snapshots store the applied rate and amount, so later rate edits never alter placed Orders.

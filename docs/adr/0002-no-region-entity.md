---
status: accepted
---
# No Region entity: country is the only geographic key

Commerce platforms like Medusa make Region the hub that currency, tax and shipping all reference, which is the over-configuration this project exists to avoid. Instead a variant has one price per currency, a shipping option has a country list, a tax rate keys on country (and optional state) plus tax category, and the storefront chooses currency separately from country.

## Consequences

- Adding a Region later means a new grouping over countries, not a migration of existing keys.
- Currency selection is a storefront concern, not derived from the shipping country.

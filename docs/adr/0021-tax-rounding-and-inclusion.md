---
status: accepted
---
# Tax: per-line half-up rounding, inclusion per region

Builds on 0004 (manual rates behind a `TaxProvider`). Rates are integer basis points per `taxCategory` in a `TaxRegion` (country, optional state; most specific match wins; no match = untaxed). `exempt` is always 0 and an unlisted category is 0, so a missing rate never invents tax.

**Rounding**: tax is computed once per cart line on the line total (`unitPrice * quantity`), never per unit, rounded half-up in integer arithmetic (no floats). Shipping is its own rounded part, taxed at the `standard` rate when the cart ships. Order tax is the exact sum of those parts, so line taxes always reconcile with the total and an invoice can show every figure without a plug.

**Inclusion**: per region. Exclusive adds `net * r`; inclusive extracts `gross * r / (1 + r)` and `cartTotals(..., { taxIncluded })` reports the tax without adding it. Converting a line between modes differs by at most one minor unit (property-tested), which is the unavoidable cost of rounding each mode independently.

## Consequences

- Discounts are not allocated across lines yet; 2.6 must pass discounted line amounts or extend `calculateTax`.
- A `TaxProvider` (0004) can replace `calculateTax` and return the same `TaxResult`.
- Order snapshots store the applied rate and amounts (0004), so rate edits never change placed orders.

---
status: accepted
---
# Discount codes: one effect per cart, race-safe redemption in the repository

**Model** (`packages/schema/src/discount.ts`): `DiscountCode` is a union on `type`: `percentage` (basis points of the subtotal), `fixed` (minor units, one currency) or `free_shipping`. Common rules: `active`, `minSubtotal`, `startsAt`/`endsAt` (window is `[startsAt, endsAt)`), `usageLimit`, `perCustomerLimit`. Codes are stored upper-case and unique; customers type them in any case.

**One code per cart**, and one effect: `applyDiscount` returns `{ amount, freeShipping }`. Stacking, per-product scopes and buy-X-get-Y are out of scope for v0.1 (no setting without a real store asking for it). The amount is off the goods subtotal and capped at it, so totals cannot go negative; percentages use the shared half-away-from-zero `multiply`. Free shipping is rejected for carts with no physical line (`no_shipping`), and a fixed code in another currency is rejected (`currency`).

**Validation vs redemption**: `applyDiscount` reads current usage for an early, friendly error, but is advisory. `DiscountRepository.redeem` is the authority: atomic and serialised per code (Postgres: one transaction under a per-code advisory lock, like inventory in 0016), it counts, checks `usageRefusal` (shared by adapters so semantics cannot drift) and inserts. Redemptions are keyed by `redemptionId` (the order id): a retry succeeds without double counting, and `release` deletes it, which is the saga's compensation. A concurrent order that loses the race gets `usage_limit`/`customer_limit`. `customerKey` is the customer id, or the lower-cased email for guests; without a key the per-customer limit is not enforced.

**Tax** (follows 0021): the discount is allocated across lines by line total with `allocate` (largest remainder, parts sum exactly) and tax is computed on the discounted line amounts, so tax still reconciles. `calculateTax(cart, region, shipping, discount)`; callers pass `shipping` 0 when `freeShipping`. Inclusive regions extract tax from the discounted gross.

**Storage**: codes are JSON documents in `discounts` with a unique index on `doc->>'code'` (ADR 0017 style); redemptions are real columns in the `discounts` migration module, forward-only.

## Consequences

- The checkout saga (2.7) calls `redeemDiscount` when creating the order and `releaseDiscount` to compensate; order snapshots should store the applied amount, not the code's current definition.
- Changing a code after use affects only future carts; usage counts live in redemptions, not on the code.

# Domain model (v0.1)

Vocabulary lives in [GLOSSARY.md](../GLOSSARY.md). This file holds structure: entities, state machines, invariants, scope. Decisions: [ADR 0002](adr/0002-no-region-entity.md), [0003](adr/0003-order-created-on-payment-success.md), [0004](adr/0004-manual-tax-with-tax-provider.md). One store per deployment; no tenant concepts.

## Entities and relationships

**Catalog**
- Product 1─* Option 1─* OptionValue; Product 1─* Variant (one per value combination; a simple product has one default Variant).
- Variant: `deliveryType` (`physical|digital|none`), `priceMode` (`fixed|customer_defined`), `taxCategory`, optional `quantityUnit` (label only), `manageInventory`, `allowBackorder`. Weight/dimensions only when `physical`. `manageInventory` defaults true for physical, false otherwise.
- Price: Variant × currency → amount (minor units). Customer-defined variants carry min, max and suggested amount per currency instead of a fixed amount.
- Collection *─* Product (manual, flat, ordered).
- DigitalAsset belongs to a Variant (`digital` only); stored in private storage.
- StockLevel: one quantity per Variant. Reservation: Variant, quantity, Cart, expiry.

**Buying**
- Customer (guest identified by email, or registered) 1─* Address; optional tax ID.
- Cart 1─* CartLine (variant, quantity, chosen amount for customer-defined, which has quantity 1). One DiscountCode per Cart. `requiresShipping` derives from line delivery types.
- PaymentSession: Cart's in-flight attempt (provider reference, status). Exists before any Order.
- Order 1─* OrderLine (snapshot), 1─* Payment, 0─* Fulfilment, 0─* Refund, 0─* TimelineEvent (notes, customer messages, status changes). Holds the order snapshot and consent record.
- Fulfilment *─* OrderLine subset, optional tracking number. DownloadGrant: order line × asset, expiry, download limit, count, revoked flag.
- Refund belongs to a Payment: amount, optional line allocation (restock, revoke grants), reason.
- Documents: Invoice (at payment), CreditNote (per Refund); each with its own gap-free sequence, generated from the snapshot.

**Store and merchant**
- DiscountCode, ShippingOption (country list; flat-rate or weight-based), TaxRate (country, optional state, tax category, inclusive flag per country), Policy (immutable versions), StoreSettings.
- AdminUser (role owner|staff|read-only), Customer sessions, ApiKey (publishable|secret, hashed), AuditEntry, WebhookEndpoint + delivery log, DomainEvent outbox.

## State machines

**Order lifecycle:** `draft → open → completed`; `open|draft → cancelled`. `completed` when paid and fully fulfilled. Cart-born Orders start at `open`; only staff drafts start at `draft`.

**Payment status:** `unpaid → requires_action | pending → paid`; `requires_action|pending → failed`; `paid → partially_refunded → refunded`. Cart-born Orders are created already `paid`; earlier states live on PaymentSession. Draft orders sit at `unpaid` until marked paid or a payment link settles.

**Fulfilment status (derived from Fulfilments):** `unfulfilled → partially_fulfilled → fulfilled`. Digital and `none` lines fulfil automatically on payment.

**Checkout saga (resumable):** reserve stock (managed variants) → start PaymentSession → pause on authentication/redirect/async → resume on verified webhook → create Order and snapshot → auto-fulfil digital/`none` → create grants → emit events. Every step has compensation, including on timeout; reconciliation job repairs dropped webhooks.

## Invariants

1. Money is integer minor units plus ISO 4217 currency; allocation never loses or invents a cent.
2. Reservations never oversell; expired reservations never count; only `manageInventory` variants reserve.
3. One Order per Cart regardless of webhook order, duplication or lateness (Cart id is the idempotency key).
4. An Order is self-contained: lines, prices, tax, address and consents are snapshotted; later edits never alter it.
5. Order, invoice and credit-note numbers are gap-free sequences allocated in the creating transaction.
6. Refunds on a Payment never exceed what was paid; a CreditNote never exceeds its Invoice.
7. Carts with no physical lines skip shipping; discount `free_shipping` applies only to shipping carts.
8. Customer-defined line amounts lie within the variant's per-currency bounds and the provider minimum.
9. Digital assets are reachable only through a valid DownloadGrant and short-lived signed URL; full refund or cancellation revokes grants; replacing an asset keeps existing grants valid.
10. Domain events carry IDs only, never personal data; deleting a Customer anonymises personal fields while order totals and documents stay correct.
11. Admin users and Customers are separate identities; roles attach to Admin users only.
12. Secrets (secret keys, webhook secrets) are shown once and stored hashed or encrypted.

## In v0.1

Physical, digital, service and donation products as one-time payments; multi-currency prices; automatic-capture payments with 3DS, redirects and async methods; manual tax rates; flat/weight shipping with manual tracking; discount codes (whole cart, one per Cart); guest order lookup; draft orders; refunds and credit notes; HTML invoices; admin roles and audit log; publishable/secret keys; outbound webhooks; policies and consents; personal-data export and deletion.

## Designed for, not built

- **Subscriptions and entitlements** (Phase 8): DownloadGrant folds into an entitlement; payment interface must never assume one-time charges.
- **Region**, stock locations, manual capture, product-targeted or stacked discounts, nested/smart collections.
- **Personalised products, license keys** (Phase 6); **bookings** (Phase 9 plugin).
- **Deferred from v0.1 scope:** PDF documents, CSV import/export, storefront tracking events, TanStack Start binding, Expo demo.
- **Carrier APIs and label purchase**, automatic tax providers (via `TaxProvider`), multi-store/tenancy.

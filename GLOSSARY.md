# Free-commerce

An opinionated, single-store commerce platform: catalog, cart, checkout, orders and fulfilment for physical goods, digital downloads, services and donations.

## Language

**Cart**:
A customer's in-progress selection of lines before checkout completes. It exists until checkout turns it into an Order.
_Avoid_: Basket, checkout session

**Order**:
A purchase whose payment succeeded, or that staff created as a draft. Carts that never pay are never Orders.
_Avoid_: Purchase, transaction

**Payment session**:
The in-flight payment attempt for a Cart (3DS, redirect or async method) before an Order exists.
_Avoid_: Payment intent (that is the Stripe term)

**Fulfilment**:
A shipment or delivery covering a subset of an Order's lines, with an optional manually entered tracking number. Digital and `none` lines are fulfilled automatically on payment.
_Avoid_: Shipment, delivery

**Download grant**:
Permission for a customer to download one digital asset from one order line, with an expiry and a download limit.
_Avoid_: Entitlement (a later concept), licence

**Customer**:
The person who buys, either a guest identified by email or a registered account.
_Avoid_: User, buyer, client

**Admin user**:
A merchant-side login with a role (owner, staff or read-only). Separate from Customer; the two share no supertype.
_Avoid_: User, staff account

**Draft order**:
An Order in lifecycle `draft` created by staff, paid by a manual payment or a payment link.
_Avoid_: Manual order, quote

**Product**:
A catalog item with optional Options. A simple product is a Product with one default Variant and no Options.
_Avoid_: Item, SKU

**Option**:
A named axis of variation on a Product (e.g. Size); each value combination is one Variant.

**Collection**:
A manual, flat list of Products. No nesting and no rule-based membership.
_Avoid_: Category

**Publishable key**:
An API key for storefronts with fixed scopes (read catalog, manage own Cart, checkout). Shown once, stored hashed.

**Secret key**:
An API key for server integrations with a fixed scope list. Shown once, stored hashed.
_Avoid_: Token

**Audit entry**:
A record of one Admin-user mutation: actor, action, entity, time and a redacted before/after summary. System and customer actions are not audited here.

**Policy**:
A store document (terms, privacy, refund, shipping) held as immutable, versioned markdown.

**Consent record**:
What a customer accepted at checkout, stored on the Order: Policy version IDs and whether immediate digital delivery waived the withdrawal right.

**Variant**:
The sellable unit of a product. It declares its delivery type, price mode, tax category and optional quantity unit.
_Avoid_: SKU, option combo

**Delivery type**:
Whether a variant is `physical`, `digital` or `none`. It drives shipping, stock, tax and fulfilment.

**Price mode**:
Whether a variant's price is `fixed` or `customer_defined` (donations, pay-what-you-want).

**Tax category**:
A merchant-defined class (standard, digital, exempt) that selects which tax rate applies to a variant.

**Tax rate**:
A merchant-entered percentage for a country (and optional state) and tax category.

**Currency**:
The ISO 4217 code a price or amount is expressed in. Chosen separately from the customer's country; a variant has one price per currency.
_Avoid_: Region (there is no Region concept in v0.1)

**Payment**:
The money movement for an Order. v0.1 captures automatically; `authorized` lives only inside the provider adapter. Status: `unpaid | requires_action | pending | paid | partially_refunded | refunded | failed`.
_Avoid_: Charge, transaction

**Reservation**:
A time-limited hold on a variant's stock for a Cart, committed when the Order is created. Expired reservations never count. Expiry is one store-wide value, extended once while payment is in flight.

**Order number**:
The gap-free, human-readable sequential number of an Order, distinct from its `ord_…` ID. Invoices and credit notes have their own sequences.

**Order snapshot**:
The line titles, unit prices, currency, tax rates and amounts, shipping address and consents copied onto an Order at creation. Later catalog, tax or policy edits never change it.

**Discount code**:
A code giving a percentage, fixed or free-shipping discount on a whole Cart, with optional usage limit and expiry. One per Cart.
_Avoid_: Coupon, promo

**Refund**:
A return of money on a Payment, with an amount and optional lines to restock and revoke grants for. Cancelling an Order is a full Refund plus lifecycle `cancelled`.
_Avoid_: Return, chargeback

**Credit note**:
The document issued for one Refund, never exceeding its invoice.

**Domain event**:
A past-tense, namespaced fact (`order.placed`) carrying an event ID and entity IDs only, never personal data. One catalogue feeds email, outbound webhooks and later Automations.
_Avoid_: Message, notification

**Saved method**:
A customer's payment method kept for off-session reuse, used for one-click upsell.

---
status: accepted
---
# Personal data: anonymise in place, delete addresses, hooks for later modules

Task 2.9. Erasure must keep orders and accounting intact, so a customer is **anonymised, not deleted**: the row stays with `email`, `name`, `phone`, `taxId` and `defaultAddressId` nulled and `anonymisedAt` set (schema already requires this). Saved addresses are deleted. Orders keep amounts, tax and lines; only the `customerId` owner link is dropped (orders hold no other personal data today; later address or email snapshots on orders must be added to `eraseCustomer`). Carts, the search index and the catalogue hold none. Audit entries and outbox events carry ids only (`customers/<id>`, `{ customerId }`), never personal data.

Core `exportCustomerData` and `eraseCustomer` take `PersonalDataDeps` (db, auth, `hooks`, clock). Later modules (download grants, 2.10) implement `PersonalDataHook { name, export, erase }`; `erase` runs inside the erasure transaction, `export` lands under `extra.<name>`.

Order of effects: one DB transaction anonymises, queues `customer.anonymised` and appends the audit entry; only after it commits are the auth account and sessions removed (`AuthProvider.deleteUser`, idempotent). A failing hook rolls the transaction back and the customer keeps their login to retry; a crash between commit and `deleteUser` leaves anonymised data with a live login that a retry removes. An auth account with no customer row (registered before this change) is deleted by erase; its export is 404 because nothing but the login is held (no backfill needed). A second erase is a no-op (`erased: false`, no second audit entry or event).

Access: customers act on themselves only (`/store/customers/me/export`, `POST /store/customers/me/erase`; the id comes from the session, never the path). Erase additionally requires the account password in the body (step-up against a stolen session) and is limited to 5 tries per 15 minutes. Export includes each order's `paymentId` on purpose: it is the customer's own payment reference, not a secret. Admin routes live under a new owner-only group `privacy` (`/admin/privacy/customers/:id/export|erase`), because both reveal or destroy personal data. Export writes its audit entry before releasing data, excludes credentials, sessions and refund fingerprints.

To make this possible: `customers` and `addresses` repositories (addresses carry `customerId`), `OrderRepository.listByCustomer`, `Order.customerId`, and customer registration now records the `Customer` row (id = auth user id, per ADR 0018). Migrations: `customers`, `addresses` (expression index on `customerId`), `orders/0002`.

## Consequences

- Guests have no session, so only an admin can export or erase them; a self-service guest path needs a verified-email flow (not planned).
- `CheckoutInput.customerId` copies the buyer onto the order. The server has no checkout route yet (1.15/3.x): that route must pass the session's customer id (never a body value). Orders placed without it, or before it existed, are not linked and are absent from exports, and erasure cannot unlink them (they hold no personal data today).
- Guest customers: the guest erase path is only covered by the fakes; add a guest case when guest customers are created. The password step-up needs a stored email, so a customer with no row cannot self-erase (an owner can).
- Erasure is irreversible and owner-only; there is no grace period.

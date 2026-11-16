---
status: accepted
---
# Personal data: anonymise in place, delete addresses, hooks for later modules

Task 2.9. Erasure must keep orders and accounting intact, so a customer is **anonymised, not deleted**: the row stays with `email`, `name`, `phone`, `taxId` and `defaultAddressId` nulled and `anonymisedAt` set (schema already requires this). Saved addresses are deleted. Orders keep amounts, tax and lines; only the `customerId` owner link is dropped (orders hold no other personal data today; later address or email snapshots on orders must be added to `eraseCustomer`). Carts, the search index and the catalogue hold none. Audit entries and outbox events carry ids only (`customers/<id>`, `{ customerId }`), never personal data.

Core `exportCustomerData` and `eraseCustomer` take `PersonalDataDeps` (db, auth, `hooks`, clock). Later modules (download grants, 2.10) implement `PersonalDataHook { name, export, erase }`; `erase` runs inside the erasure transaction, `export` lands under `extra.<name>`.

Order of effects: the auth account and sessions are removed first (`AuthProvider.deleteUser`, idempotent), then one DB transaction anonymises, queues `customer.anonymised` and appends the audit entry. A crash between the two leaves a customer who cannot sign in and a retry that completes; a failing hook rolls the transaction back. A second erase is a no-op (`erased: false`, no second audit entry or event).

Access: customers act on themselves only (`/store/customers/me/export`, `POST /store/customers/me/erase`; the id comes from the session, never the path). Admin routes live under a new owner-only group `privacy` (`/admin/privacy/customers/:id/export|erase`), because both reveal or destroy personal data. Export writes its audit entry before releasing data, excludes credentials, sessions and refund fingerprints.

To make this possible: `customers` and `addresses` repositories (addresses carry `customerId`), `OrderRepository.listByCustomer`, `Order.customerId`, and customer registration now records the `Customer` row (id = auth user id, per ADR 0018). Migrations: `customers`, `addresses` (expression index on `customerId`), `orders/0002`.

## Consequences

- Guests have no session, so only an admin can export or erase them; a self-service guest path needs a verified-email flow (not planned).
- Orders placed before `customerId` existed are not linked and so are absent from exports; checkout (2.7) must set `customerId` for signed-in buyers.
- Erasure is irreversible and owner-only; there is no grace period.

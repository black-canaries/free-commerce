---
status: accepted
---
# Auth: `AuthProvider`, Better Auth, separate realms, sessions

Task 1.10 (🔒). Auth is a provider (ADR 0007): interface and fake in `core`, vendor in its own package.

## Decisions

- **Interface** (`core/providers/auth.ts`): `signUp`, `signIn`, `authenticate`, `signOut`, each taking a realm (`admin` | `customer`). Sessions are opaque tokens; the interface says nothing about cookies, so React Native and web share it. A fake and `authConformance` (core/testing) pin the behaviour: wrong password and unknown email are indistinguishable, tokens never cross realms, sign-out and expiry invalidate, a repeated sign-up never alters the existing account.
- **Better Auth 1.7.25** (`packages/auth-better-auth`, new runtime dependency, only there; none in `core`). It owns password hashing (scrypt), session storage and token signing, which we must not hand-roll. We use only its server `api` (no HTTP handler is mounted), the `bearer` plugin (signed token usable as `Authorization: Bearer`), and a pluggable database.
- **Two realms = two Better Auth instances**, each with its own tables, secret (`<realm>:<secret>`) and ID prefix (`adm_`, `cus_`). An admin token is unknown to the customer instance and vice versa, so a privilege boundary is structural, not a role check. Customer user IDs are `cus_...` so they are the ownership key for orders.
- **Transport** (server): web gets an `HttpOnly`, `Secure` cookie (`fc_customer`, `fc_admin`; `SameSite` configurable, `None` for storefronts on another origin); native sends `mode: "bearer"` and receives the token in the body, then uses `Authorization: Bearer`. Cookie-authenticated admin writes additionally need an `Origin` in `allowedOrigins` (CSRF); storefront requests are CSRF-proof because they must carry the `x-api-key` header, which a cross-site form cannot set.
- **Admin accounts** are created out of band (`provider.signUp("admin", ...)` from a seed/CLI); no public admin sign-up route exists. Roles and permissions are 1.11.
- **Login hardening**: auth routes get a stricter per-client rate limit (10/min) than the API; Better Auth's own limiter and logger are off (the server owns both) so credentials and failures never reach logs. A taken email returns a generic `conflict`; Better Auth itself answers duplicate sign-ups with a throwaway success (anti-enumeration), which the register route resolves by signing in with the submitted password.
- **Auth routes are exempt from idempotency**: a stored login response would persist a session token.

## Consequences

- Default database is Better Auth's in-memory adapter (tests, demos). A Postgres deployment passes `databases: { admin, customer }` (e.g. `drizzleAdapter`); generating those tables/migrations with Better Auth's CLI is deferred to the demo app (task 4.x), not tested here.
- Customer records (`Customer` entity) are not created at registration yet: there is no customers repository (task 1.5/1.14). `customerOrders` is injected into the app so ownership is enforced at the route; the real query lands with order routes.
- Email verification, password reset and social login are out of scope (need email providers, 2.x).

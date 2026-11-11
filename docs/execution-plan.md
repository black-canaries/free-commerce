# Free-commerce: Execution Plan

For Claude Code. Read `claude-code-brief.md` first. It holds the **prime directive (every line of code must have a purpose and belong; use as little code as necessary)**, the decisions, scope calls, rules and cross-cutting requirements. Tasks run in order; each has scope and acceptance criteria. Phases 0-5 deliver v0.1. Phases 6-9 are outlined and get expanded into tasks when reached.

Every task is bound by the prime directive: do the smallest thing that meets the acceptance criteria, reuse before adding, and report net lines and new dependencies in the PR. If a task grows far beyond its description, stop and ask.

Legend: `[ ]` todo, `[x]` done. ⚑ = checkpoint: stop and review with Jon before continuing. 🎨 = **design gate**: the UI is designed in canvas-agents and approved by Jon before any implementation. A 🎨 task is split into a design step (D) and an implementation step (I); I cannot start until D is approved. 🔒 = **security-critical**: needs an independent review (fresh session, security checklist) and Jon's review before merge. 👤 = Jon does this himself.

## Product types in v0.1
Every variant declares `deliveryType` (`physical | digital | none`), `priceMode` (`fixed | customer_defined`), optional `quantityUnit` (e.g. hour) and `taxCategory`. This covers physical goods (simple and variable), digital downloads, services, and donations or pay-what-you-want, all as one-time payments. Subscriptions, memberships, bookings, license keys and personalised products are out of v0.1 but designed for (see the domain model, section 5).

## Design gates, at a glance
Canvases to create in canvas-agents (one per area), with links recorded in `docs/design/README.md`:
1. **Design System:** tokens (colour, type, spacing, radius, elevation, motion), light/dark, core primitives, icon set, accessibility notes.
2. **Storefront UI Kit:** product grid/card, variant picker, customer-defined amount input, cart drawer, checkout (one-page and multi-step, with and without shipping, including authentication and redirect states), country-aware address forms, order summary, shipping selector, account pages including downloads, guest order lookup and order status, cookie consent, policy links and consent checkboxes.
3. **Funnel Layouts:** checkout, order bump, upsell, downsell, thank-you, opt-in, landing; default variants.
4. **Admin:** shell, navigation, command palette, notifications, dashboard metrics, products (including delivery type, price mode and digital assets), media, orders (including draft orders, notes, customer messages, invoices), customers, discounts, import/export, roles, audit log, settings (API keys, webhooks, policies, invoice settings), empty/loading/error states.
5. **Flow Editor:** node editor, node types, inspector, validation states, run/analytics overlays. (Phase 7)
6. **Email Templates and Documents:** transactional emails (including staff new-order notification), invoices, receipts and credit notes (Phase 2); automation templates (Phase 6).
7. **Docs Site and CLI output:** docs layout, landing page, install experience.

## Phase 0: Foundations

- [x] **0.0 👤 Name decision (settled for now: keep "Free-commerce").** Decision: keep the working name `Free-commerce` for development and make renaming cheap (task 0.2a). Name candidates were checked and none cleared GitHub, npm, domain and trademark together (see the ADR). Claude Code writes `docs/adr/0001-name-and-namespace.md` recording: the decision, the candidates checked and why they failed, the concern that "free" can read as "costs nothing" rather than freedom, and the **rename gate** (a final name confirmation before the first public npm publish in 5.8).
  👤 Jon, not blocking: reserve what is cheap to reserve under the working name (npm org `free-commerce`, GitHub org, a domain) when convenient, and run a real trademark search before 5.8. Availability of these was not verified.
  *Accept:* ADR committed; `brand.json` values (see 0.2a) match the decision. Development proceeds without waiting on accounts.
- [ ] **0.1 Claude Code setup and workflow.** Add `CLAUDE.md` (from the brief), configure hooks (typecheck and lint after edits, package tests and secret scanning before commit), set up MCP servers (canvas-agents, Postgres dev inspection), create `docs/adr/` with a template, and add the branch/PR conventions and a PR template that asks for: task ID, acceptance evidence, **net lines added and removed, justification for each new file or dependency, and what existing code was considered**, and the 🔒 review record.
  *Accept:* a trivial task goes branch, edit, hook-checked, PR with the template filled in; ADR template renders.
  *Status:* hooks, PR template, ADR template done. Open: MCP config (canvas-agents, Postgres) needs Jon's server details; hooks unproven until a first PR.
- [x] **0.2 Monorepo scaffold.** pnpm workspace, Turborepo pipeline (build, typecheck, lint, test), root scripts, `.editorconfig`, `.gitignore`, Changesets. Empty packages: `config`, `schema`, `core`.
  *Accept:* `pnpm install && turbo run build typecheck lint test` passes on a clean clone.
- [x] **0.2a Brand config and rename script.** The name must be changeable later without a hunt through the repo. Keep this as small as possible:
  - A root `brand.json` is the single source of truth: product name, slug, npm scope, CLI command, environment variable prefix, domain, repository URL. Code, UI and docs that need the name read it (via a tiny helper exported from `packages/config`); the name is never typed into strings, UI copy or generated output by hand.
  - One script, `pnpm rename --to <name> [--scope @x]`, that previews by default and applies with `--write`. It rewrites `brand.json`, package names and scope, internal imports, tsconfig paths, the CLI binary name, the environment variable prefix, registry references and prose mentions in `docs/` and the README. It does not touch the git history or external accounts.
  - A CI check fails if the current or a previous brand name appears hard-coded outside `brand.json`, the ADR and an explicit allowlist.
  *Accept:* running the script on a fixture rename leaves `turbo run build typecheck lint test` green; the CI check fails on a deliberately hard-coded name; the script and check together stay small (report the net lines).
- [ ] **0.3 Shared config.** `packages/config` with base tsconfig (strict, ESM), Biome config (including complexity limits), Vitest preset, Playwright base config.
  *Accept:* all packages extend the shared config; no per-package duplication.
  *Status:* base tsconfig, Biome (complexity limit 12) done at repo root; Vitest preset and Playwright base deferred until a package needs them (no per-package config exists yet).
- [ ] **0.4 CI and code-minimalism guardrails.** GitHub Actions: install with cache, typecheck, lint, test, dependency audit, secret scanning, on Node LTS. Add the checks that enforce the prime directive: **unused files, exports and dependencies (knip), duplicate-code detection, complexity limits, bundle-size budgets for client packages, and a PR comment reporting net lines changed.** Playwright job stub for later.
  *Status:* workflow written (lint, typecheck, build, test, knip, jscpd, audit, gitleaks, net-lines comment); local checks pass. Open: verify on a real PR; bundle budgets with first client package (3.1); Playwright stub with 4.8.
  *Accept:* CI green on a PR; fails on a deliberate type error, a known-vulnerable dependency, a committed secret, an unused export, and a duplicated block.
- [x] **0.5 Governance and policies.** MIT `LICENSE`, `README`, `CONTRIBUTING` (DCO sign-off, the prime directive), `CODE_OF_CONDUCT`, `SECURITY`, issue and PR templates. Add `docs/versioning.md`: semver policy, `@public` vs `@experimental` exports, deprecation window, and the rule that migrations are per-module, forward-only and upgrade-tested. Add `docs/assets.md` recording licences for demo images, fonts and icons.
- [ ] **0.6 Connect canvas-agents and set up design workspace.** Confirm the canvas-agents MCP server is available to Claude Code. Create the canvases listed above. Create `docs/design/README.md` linking each canvas and describing the design workflow.
  *Accept:* Claude Code can read from and write to the canvases via MCP; a test frame is created and deleted successfully.
- [x] **0.7 ⚑ Domain model.** Start from `domain-model-draft.md` in the project, refine it, resolve its open modelling questions with Jon, and commit `docs/domain-model.md`. It must cover entities and relationships, state machines (including resumable payment states and draft orders), the glossary, invariants, what is in v0.1, and what is "designed for, not built". Challenge every entity and field against the prime directive: cut what v0.1 doesn't need.
  *Accept:* Jon reviews and approves; every Phase 1 and 2 task refers to this doc rather than inventing entities.
- [x] **0.8 🔒 Schema conventions.** In `schema`: `Money` (minor units + currency, helpers for add/multiply/allocate with rounding), prefixed ID generator, timestamp helpers, pagination and error shapes (typed error codes).
  *Accept:* property-based tests for money (allocation never loses or invents a cent).
- [x] **0.9 Repository interfaces + in-memory adapter.** Define `ProductRepository`, `CartRepository`, `OrderRepository` (minimal), `transaction()`; implement an in-memory adapter; create `adapter-testkit` skeleton that runs against any adapter.
  *Accept:* testkit passes against the in-memory adapter.
- [x] **0.10 Provider interface conventions.** Define the pattern for external-service providers (payments, email, SMS, storage, search, auth, captcha): interface, fake implementation for tests, config schema, error mapping, and a conformance test helper.
  *Accept:* one worked example (a fake `StorageProvider`) with conformance tests; documented in an ADR.
- [ ] **0.11 Saga runner spike.** Typed step runner with compensation, retries with idempotency keys, step-level result recording, OpenTelemetry spans per step, and the ability to **pause on an external event (such as a payment webhook) and resume**. Demo with a fake `completeCheckout`.
  *Accept:* tests for success, failure at each step (compensations run in reverse), retry idempotency, and pause/resume including a timeout that compensates.
- [x] **0.12 Flow graph schema spike.** `packages/flow`: node/edge schema, validator (reachability, single trigger, no dangling edges), draft/published versioning model. No UI yet.
  *Accept:* validator tests; a sample abandoned-cart graph validates.
- [ ] **0.13 🎨 ⚑ Design system.**
  - **D:** In canvas-agents (Design System canvas), design the brand direction and tokens (colour, type scale, spacing, radius, elevation, motion), light and dark themes, and core primitives (button, input, select, checkbox, toggle, dialog, popover, toast, table, tabs, badge, card, empty state). Include states (hover, focus, disabled, error, loading) and accessibility notes. Present options if the direction is open, then iterate with Jon. Keep logo and wordmark out of the system until the name is confirmed (see the rename gate in 5.8).
  - **I:** Export tokens to `docs/design/tokens` and implement them in `packages/ui` (CSS variables + Tailwind 4 theme) with the primitives, message-catalog support for strings, and a demo page.
  *Accept:* Jon approves the design; light/dark switch works; keyboard navigation and focus styles correct; demo page matches the frames.
- [ ] **0.14 🎨 ⚑ Layout + content-schema spike.**
  - **D:** In the Funnel Layouts canvas, design three layouts (checkout, upsell, thank-you), each with the editable fields marked (headline, body, button label, image, products) and its variants.
  - **I:** Prototype the layout contract: a layout registers a component and a content schema; a generated form edits the content; a sample renderer shows it in a Next.js test app.
  *Accept:* all three layouts render from stored JSON content and defaults, matching the frames; review the contract with Jon before freezing it.

## Phase 1: Backend core
No UI in this phase, so no design gates. API design should still favour the screens that will consume it, so read the Admin canvas (when it exists) before finalizing admin routes. Each task follows the domain model.

- [ ] **1.1 Catalog domain.** Products, options, variants, collections, product status. Variant behaviour fields: `deliveryType`, `priceMode`, `quantityUnit`, `taxCategory`, with validation (for example, weight and dimensions only for `physical`; `manageInventory` defaults by delivery type). Schemas, repository methods, services, tests.
- [ ] **1.2 Pricing.** Multi-currency prices per variant; price resolution for a currency/region. Customer-defined mode: min, max and suggested amounts per currency, with validation of a chosen amount (within bounds, at least the payment provider minimum).
- [ ] **1.3 🔒 Inventory.** Stock levels per variant, reservations with expiry, release and commit. Only variants that manage inventory create reservations. Expiry is enforced at read time (expired reservations never count); the cleanup sweeper arrives in 2.11.
  *Accept:* property-based tests: reservations never oversell under concurrent attempts (in-memory and Postgres); digital and `none` variants never reserve stock by default.
- [ ] **1.4 Cart domain.** Create/get cart, add/update/remove line items (including customer-defined amounts and quantity units), totals calculation (subtotal, discount, shipping, tax, total) via pure functions. `requiresShipping` is derived from line delivery types; carts with no physical lines skip shipping.
- [x] **1.5 Customers and addresses.** Customer entity (including optional tax ID), guest vs registered. Addresses validated and formatted per country using a maintained dataset, not hand-written rules.
  *Accept:* addresses for a sample of countries (US, UK, DE, JP, BR) validate and format correctly; invalid postal codes are rejected.
- [ ] **1.6 Orders.** Order entity with three independent statuses per the domain model (lifecycle `draft | open | completed | cancelled`; payment `unpaid | requires_action | pending | paid | partially_refunded | refunded | failed` (auto-capture; see `docs/domain-model.md`); fulfilment `unfulfilled → partially_fulfilled → fulfilled`) and transition rules as pure functions. Digital and `none` lines complete fulfilment automatically on capture. Order notes and customer messages are timeline events.
- [ ] **1.7 adapter-postgres.** Drizzle schema, SQL migrations per module, repository implementations, transactions.
  *Accept:* complete `adapter-testkit` suite passes on Postgres (Testcontainers or a CI service) and in-memory; an upgrade-migration test harness exists for later releases.
- [ ] **1.8 ⚑ Repository interface review.** Check for leakage of Drizzle/SQL concepts. Sketch what a Convex adapter would need. Freeze the interface only after review.
- [x] **1.9 Server skeleton and ops baseline.** Hono app factory, `/store` and `/admin` route groups, error handling with typed codes, request validation from schemas, idempotency-key middleware, structured logging with request IDs, OpenTelemetry setup, `/health` and `/ready` endpoints, rate limiting middleware, validated env config.
  *Accept:* a request produces a log line and trace with the same request ID; health endpoints reflect DB connectivity; rate limit returns a typed error.
- [ ] **1.10 🔒 Auth, API keys and sessions.** `AuthProvider` interface, Better Auth implementation, separate admin and customer auth, session middleware. **Publishable keys (storefront, read and cart scopes) and secret keys (server integrations, scoped), stored hashed and shown once, with rotation and revocation.** CORS configuration for storefronts on other origins; cookie sessions for web and bearer tokens for React Native.
  *Accept:* admin routes reject unauthenticated requests; customer can register, log in, and read their own orders only; a publishable key cannot call admin routes; a revoked key stops working immediately; secrets are never retrievable after creation.
- [ ] **1.11 🔒 Roles, permissions and audit log.** Roles (owner, staff, read-only), permission checks on every admin route, audit log entries for admin mutations (who, what, when, before/after summary), audit query endpoint.
  *Accept:* a read-only user cannot mutate; every admin mutation produces an audit entry; tests cover each role against each route group.
- [ ] **1.12 🔒 Media and private file storage.** `StorageProvider` interface with local-disk and S3/R2-compatible implementations; public media assets with image variant generation; **private storage** for digital assets with short-lived signed URLs; upload endpoints with size and type validation.
  *Accept:* conformance tests pass for both providers; oversized and wrong-type uploads are rejected; a private object is not reachable without a valid signed URL.
- [ ] **1.13 Catalog search and filtering.** `SearchProvider` interface with a Postgres full-text implementation; filters (collection, option values, price range, availability, delivery type), sorting, pagination.
  *Accept:* relevance and filter tests; performance baseline recorded on a seeded catalog of 10,000 products.
- [ ] **1.14 Store and admin routes.** Catalog read and search, cart operations, customer routes (store); catalog, media, digital assets, inventory, order management (admin).
- [ ] **1.15 OpenAPI and contract tests.** Generate the spec from schemas; publish at `/openapi.json`; contract tests verify the routes match the spec.
  *Accept:* a full order can be placed via API only (test script), for a physical, a digital and a customer-defined-amount product.

## Phase 2: Checkout and payments
Backend only, except the payment client flow in 2.3 (covered by the checkout design in 3.4), the email templates and documents (designed in 2.0 and 2.12).

- [ ] **2.0 🎨 Transactional email.**
  - **D:** In the Email Templates canvas, design the transactional templates: order confirmation, shipping notification, digital delivery (download links), password reset, account verification, **staff new-order notification**. Cover plain-text fallbacks and dark-mode behaviour.
  - **I:** `EmailProvider` interface, Resend and SMTP implementations, a template system (developer-owned components with content schemas, matching the layout model), and the templates wired to events.
  *Accept:* Jon approves the design; provider conformance tests pass; order confirmation sends once per order even when the event is redelivered.
- [ ] **2.1 Event bus + outbox.** In-process bus, Postgres outbox table, relay, at-least-once delivery with idempotent subscribers.
- [ ] **2.2 🔒 Payment provider interface.** Create a payment session; confirm; handle states `requires_action` (customer authentication or redirect), `pending` (asynchronous methods), `authorized`, `captured`, `failed`; `capture`, `refund`, **`chargeSavedMethod`** (needed for one-click upsells); verified inbound webhook handling. Write an ADR on how recurring billing (subscriptions) will fit later, and confirm the interface and saved-method model do not assume one-time charges only. Do not build recurring features. Include a `manual` provider (bank transfer, cash) for admin-marked payments.
- [ ] **2.3 🔒 Stripe provider.** `payments-stripe` with PaymentIntents and the Payment Element (cards, wallets such as Apple Pay and Google Pay, redirect methods), 3D Secure / SCA handling, webhook handling with idempotency and signature verification, saved payment method for off-session reuse.
- [ ] **2.4 Shipping.** Shipping option provider interface; flat-rate and weight-based implementations; applies only to carts that require shipping.
- [ ] **2.5 Tax.** Manual regional rates by tax category (standard, digital, exempt); tax-inclusive or exclusive per region; tax calculation in cart totals.
- [ ] **2.6 Discount codes.** Percentage, fixed, free shipping (shipping carts only); usage limits; validation rules.
- [ ] **2.7 🔒 `completeCheckout` saga.** A **resumable** saga: reserve stock (managed variants only), start payment, pause while the customer authenticates or an asynchronous method settles, resume on the payment webhook, create the order, capture, auto-fulfil digital and `none` lines, create download grants, emit events; full compensation, including on timeout. Record the customer's consents (terms, and immediate digital delivery where applicable) on the order.
  *Accept:* failure injected at every step leaves no leaked reservation, no orphan payment, no half-created order, no stray download grant; double submit with the same idempotency key creates one order; a webhook that arrives late, twice, or before the redirect returns still produces exactly one order; an abandoned authentication releases the reservation.
- [ ] **2.8 🔒 Refunds and cancellations.** Admin-initiated, with inventory restock options; full refund or cancellation revokes download grants.
- [ ] **2.9 🔒 Personal data export and deletion.** Customer data export (JSON) and deletion/anonymisation that preserves order and accounting integrity; admin and customer-initiated paths; audit entries.
  *Accept:* after deletion no personal data remains in customers, addresses, logs or outbox, while order totals remain correct.
- [ ] **2.10 🔒 Digital delivery.** `DigitalAsset` and `DownloadGrant` entities, store endpoints to list a customer's downloads (including guests via a secure link from the delivery email) and to issue short-lived signed URLs, download counting and limits, expiry, revocation, admin upload and replacement of assets, store settings for link lifetime and download limit.
  *Accept:* tests cover limit exhaustion, expiry, revocation on refund, guest access with and without a valid token, and asset replacement keeping existing grants valid.
- [ ] **2.11 🔒 Minimal scheduler and sweepers.** A `tick()` entry point (driven by a cron trigger or Node interval) and a Postgres jobs table with leasing and retries, kept as small as possible; Phase 6 extends it for automations rather than replacing it. First jobs: reservation expiry cleanup, abandoned-checkout cleanup, and **payment reconciliation** (compare provider state with orders and repair missed or duplicated webhooks).
  *Accept:* two workers never run the same job concurrently; reconciliation repairs an order whose webhook was dropped; jobs are idempotent.
- [ ] **2.12 🎨 Invoices, receipts and credit notes.** *(v0.1 scope: HTML only; PDF rendering deferred.)*
  - **D:** In the Email Templates and Documents canvas, design the invoice, receipt and credit note, including tax lines, tax IDs and localisation.
  - **I:** Sequential, gap-free numbering per document type; invoice generated at payment capture; credit note per refund; rendered as HTML and PDF behind a small renderer interface; link in the order email and customer account; store settings for legal name, address and tax ID.
  *Accept:* Jon approves the design; numbers never skip or repeat under concurrency; a credit note never exceeds its invoice; totals and tax lines match the order exactly.
- [ ] **2.13 🔒 Outbound webhooks.** Webhook endpoints (URL, event filter), HMAC-signed deliveries driven by the outbox, retries with backoff, a delivery log, manual replay, secret shown once.
  *Accept:* a failing endpoint is retried and eventually disabled with a visible reason; signatures verify with the documented algorithm; replays are idempotent for receivers via an event ID.
- [ ] **2.14 🔒 Abuse protection.** `CaptchaProvider` interface (Turnstile first) on registration, login and checkout; rate limits and lockouts on login, coupon validation and checkout; limits on failed payment attempts per cart, IP and email (card-testing defence); pass-through of the payment provider's fraud signals.
  *Accept:* automated card-testing and coupon brute-force scripts are blocked in tests; legitimate checkout is unaffected.
- [ ] **2.15 Guest order lookup.** Store endpoint to look up an order by order number and email, plus signed links from order emails; no personal data returned without a valid proof.
- [ ] **2.16 Admin order tools.** Draft (manual) orders created by staff, with the `manual` payment provider or a payment link, marking as paid; order notes; send a message to the customer from the order; resend emails and documents.
  *Accept:* a draft order becomes a normal order on payment, with correct audit entries, invoice and fulfilment.
- [ ] **2.17 Store policies and consents.** Store settings for terms, privacy, refund and shipping policies as versioned markdown (with starter templates clearly marked as not legal advice); consent records on orders store which policy version was accepted.

## Phase 3: SDK, UI kit and bindings

- [ ] **3.1 `sdk`.** Typed fetch client from the OpenAPI/schemas; works in Node, edge, browser and React Native. Contract tests against the spec.
- [ ] **3.2 `react` hooks.** `useCart`, `useProducts`, `useCheckout`, `useDownloads`, `useOrderLookup` on TanStack Query; optimistic cart updates.
- [ ] **3.3 UI registry + CLI `add` command.** Registry format, versioning, diff-on-update, `<cli> add <component>` (the CLI name comes from `brand.json`), message catalogs shipped with components.
- [ ] **3.4 🎨 ⚑ Storefront UI kit (web).**
  - **D:** In the Storefront UI Kit canvas, design the full set: product grid/card, variant picker, **customer-defined amount input (quick-pick suggested amounts, min and max feedback)**, search and filters, cart drawer, checkout (one-page and multi-step, **with and without a shipping step**, including payment, **customer authentication and redirect return states**, country-aware address forms, digital-delivery and policy consent checkboxes, and error states), order summary, shipping selector, account pages **including downloads and invoices**, **guest order lookup and order status**, cookie and consent banner. Cover empty, loading, error, long-content and responsive states, built from the approved design system.
  - **I:** Implement as registry components (accessible, tokens-driven, i18n-ready) with a demo page per component.
  *Accept:* Jon approves the design; implemented components match the frames; WCAG 2.1 AA checks pass.
- [ ] **3.5 `next` binding.** Server helpers, cookie-based cart session, cache tags, SEO helpers (metadata, sitemap, robots, structured data for products).
- [ ] **3.6 🎨 `demo-web` (Next.js).**
  - **D:** Design the demo store pages (home, collection, product, cart, checkout, confirmation, account, order lookup) in the Storefront UI Kit canvas from the kit components. Include one physical, one digital and one donation example product.
  - **I:** Build the storefront.
  *Accept:* a Playwright end-to-end test browses, adds to cart, checks out with Stripe test mode (including a 3D Secure test card) and sees the order in the admin API, for a physical product, a digital download (and downloads it) and a donation; pages match the frames; Lighthouse performance and accessibility budgets are met.
- [ ] **3.7 DEFERRED past v0.1: `tanstack-start` binding + `demo-tanstack`.** Reuses the 3.6 designs; no new design gate unless the layout differs.
- [ ] **3.8 DEFERRED past v0.1: 🎨 `react-native` binding + `ui-native` + `demo-mobile` (Expo).**
  - **D:** Design the mobile storefront in canvas-agents: native navigation, product and cart screens, checkout, the deep-link return from hosted payment and authentication, offline cart states, downloads (open or share a file). Follow platform conventions; reuse the tokens.
  - **I:** Implement `ui-native` components and the Expo demo.
  *Accept:* Jon approves the design; secure storage, deep-link return and offline-tolerant cart work on iOS and Android simulators.
- [ ] **3.9 DEFERRED past v0.1: Storefront tracking events.** A small standard event layer in the SDK and hooks (view item, view collection, add to cart, begin checkout, add payment info, purchase, and so on) with pluggable trackers (dataLayer, GA4, Meta Pixel). Nothing loads or fires until cookie consent allows it.
  *Accept:* a demo run produces the expected event sequence; with consent withheld, no tracker loads and no event is sent.

## Phase 4: Admin
Design the whole admin before implementing any of it, so navigation and patterns stay consistent.

- [ ] **4.0 🎨 ⚑ Admin design.**
  - **D:** In the Admin canvas, design the shell (navigation, command palette, search, breadcrumbs, notifications including new-order alerts), then each area: dashboard with sales metrics (revenue, orders, average order value, top products), products and collections (list, create/edit with variants, **delivery type, price mode, quantity unit, tax category, digital asset upload**, media library, pricing, inventory), orders (list, filters, detail, fulfil, refund, cancel, **draft orders, notes, customer messages, invoices and credit notes, download grants**), customers, discounts, **import and export (CSV)**, team and roles, audit log, settings (store, currencies, shipping, taxes, payments, email, digital delivery, **API keys, webhooks, policies, invoice settings**), plugin slot placements. Cover empty, loading, error, bulk-action and permission states, plus keyboard flows. Aim for the fewest steps to complete each common task, and document the step count for the key tasks (create product, fulfil order, issue refund). Creating a simple product of any kind should feel like one short form, not a configuration exercise.
  - **Accept:** Jon approves each area before its implementation task starts.
- [ ] **4.1 Admin app shell (I).** Routing, auth, layout, navigation, command palette, notifications, role-aware UI, from the approved design.
- [ ] **4.2 Products, collections and media (I).**
- [ ] **4.3 Orders (I).** Including draft orders, notes, customer messages and documents.
- [ ] **4.4 Customers and discounts (I).**
- [ ] **4.5 Team, roles and audit log (I).**
- [ ] **4.6 Settings (I).** Including API keys, webhooks, policies and invoice settings.
- [ ] **4.7 Plugin slots (I).** Registered routes and widgets.
- [ ] **4.8 Admin end-to-end tests.** Playwright tests for create product (each kind), fulfil order, refund, draft order, and role restrictions.
- [ ] **4.9 DEFERRED past v0.1: CSV import and export.** Products (with variants and prices), customers and orders; validation with row-level error reports; large files processed in chunks. Importers from other platforms are a Phase 9 item.
  *Accept:* a round trip (export, edit, import) leaves the catalog unchanged; a bad row reports a clear error without aborting valid rows.
- [ ] **4.10 Dashboard metrics.** Aggregate queries for revenue, orders, average order value, conversion inputs and top products over a date range; simple SQL aggregates, no separate analytics store.
  *Accept:* metrics match a hand-computed fixture; queries stay fast on a seeded store with 100,000 orders.
  *Accept (phase):* a non-developer can run the store day to day; keyboard-only and screen-reader pass on core flows; screens match the frames.

## Phase 5: Alpha

- [ ] **5.1 `create-<brand>` CLI.** Scaffold a working store (Next.js + Postgres) with seed data; `migrate` and `seed` commands. The package and command names come from `brand.json` (currently `create-free-commerce`). Design the CLI output (prompts, progress, success message) as part of the Docs Site and CLI canvas.
  *Accept:* clean machine to working store in under 10 minutes.
- [ ] **5.2 Deployment.** Dockerfile and docker-compose for local and self-hosted use; reference deployment guides for Node on a VPS, Vercel (storefront) plus a Node host, and Cloudflare; environment variable reference; backup and restore notes; email deliverability setup (SPF, DKIM, DMARC) for Resend and SMTP.
  *Accept:* each guide has been followed from scratch on a clean account and works.
- [ ] **5.3 🎨 Docs site.**
  - **D:** Design the landing page and docs layout (navigation, search, code blocks, API reference, UI registry browser) in the Docs Site canvas.
  - **I:** Quickstart, concepts, API reference, UI registry reference, deployment guides, versioning and upgrade guide, plugin API guide (including the statement that plugins run in-process with full trust).
- [ ] **5.4 Upgrade and API stability check.** Mark the `@public` / `@experimental` surface; add an API-extractor-style check that fails CI on breaking changes to `@public`; run the upgrade-migration test from a seeded earlier schema.
  *Accept:* a deliberate breaking change to a public export fails CI.
- [ ] **5.5 🔒 Security and compliance review.** Dependency audit, authz test pass across roles and API key scopes, rate limiting and abuse protection verified, secret handling, signed-URL and private-asset review, webhook signature review, PCI SAQ-A scope notes, GDPR checklist (data export/delete, consent, retention), digital-goods consent and VAT notes, a review of every 🔒 task's independent-review record, external review booked.
- [ ] **5.6 Performance and compatibility.** Checkout load test (for example with k6) at a target concurrency with no oversell and acceptable latency; catalog caching strategy documented and tested; Lighthouse and bundle budgets; browser and device matrix verified.
  *Accept:* results recorded in `docs/performance.md`; budgets enforced in CI.
- [ ] **5.7 👤 ⚑ Dogfood.** Run a real store (Jon's) on v0.1 for an agreed period before announcing. Log every problem as a task or ADR; fix the ones that block real use.
  *Accept:* real orders processed end to end, including a refund, a digital delivery and an invoice, without manual database fixes.
- [ ] **5.8 👤 ⚑ Name gate and release v0.1 alpha.** Before anything is published to npm, **confirm the final name with Jon**: keep Free-commerce or run `pnpm rename`. Publishing a package name is hard to undo, so this is the last cheap moment. Jon first completes, under the confirmed name: the npm org/scope, GitHub org and repo, domain(s) and a real trademark search. Then Changesets publish, announcement, issue templates live.
  *Accept:* ADR 0001 updated with the final decision; `brand.json` matches the registered accounts; no hard-coded old name remains (CI check from 0.2a is green); the packages publish under the confirmed scope.

## Later phases (outline; expand into tasks when reached)
- **Phase 6, growth layer 1:** extend the scheduler for automations (delays, timers, retries), contacts, cart capture with consent model, abandoned-cart template on the real automation runtime, order bump and one-click upsell using the layout model, personalised products (line item properties), license keys on the grant mechanism, address autocomplete provider, server-side conversion tracking (Meta Conversions API, GA4 Measurement Protocol) gated by consent. 🎨 Design the automation email templates, the order bump and upsell layouts, the contacts and cart-recovery admin screens, the personalisation inputs and the consent UI before building. Legal review of messaging consent first.
- **Phase 7, visual builders:** 🎨 design the Flow Editor canvas first (node types, inspector, validation, run and analytics overlays, funnel canvas, schema-driven step editor), then build `flow-editor` (React Flow), automations (full node set, recipes, SMS, task log) and the funnel builder (canvas, offer paths, rules, A/B tests, analytics).
- **Phase 8, subscriptions and entitlements:** recurring billing on Stripe Billing (plans, trials, renewals creating orders, failed-payment retries, plan changes, customer portal), entitlements for memberships and gated access, with `DownloadGrant` folded into the entitlement model. 🎨 Design plan selection, the customer billing portal, subscription management in the admin, and dunning emails first. Revisit the payment provider interface using the Phase 2 ADR.
- **Phase 9, ecosystem:** Supabase and Convex adapters, more providers, external search engines, platform importers (Shopify, WooCommerce, Medusa), plugin registry, and a first-party **bookings plugin** (availability, slots, capacity, time zones, cancellations) built on the stable plugin API. 🎨 Design the plugin registry browsing experience and the booking UI.

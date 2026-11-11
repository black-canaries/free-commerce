# Free-commerce: Claude Code Brief

Copy this into the repo root as `CLAUDE.md` (trim as the repo grows). Full design lives in `architecture-and-roadmap.md`; tasks live in `execution-plan.md`. Domain details live in `docs/domain-model.md` once task 0.7 is done (start from `domain-model-draft.md`).

## Prime directive: less code, with purpose

**The definition of a quality codebase is one where every line of code has a purpose and belongs.** Code is a surface for failure. The more code it takes to reach an intended purpose, the greater the chance of bugs, security vulnerabilities and performance problems. Good codebases use as little code as necessary to reach their desired outcome. AI coding agents tend to write copious amounts of code, so this is the first thing to remember on every task, and it outranks every other convention in this file.

How to apply it:
1. **Before writing code, try not to.** Can the requirement be simplified or dropped? Does existing code, the platform or standard library already do it? Does a well-maintained dependency already solve it? Reshaping or deleting scope beats adding code.
2. **Write the smallest change that meets the acceptance criteria.** No speculative abstractions, "just in case" options, unused parameters, unused code paths, or generalisation before the third real use. Don't add features, configuration, error handling for impossible cases, or logging noise that the task didn't ask for.
3. **Every line must be explainable.** If you can't say what a line, file, function or dependency is for, remove it. Delete dead code the moment it appears. Don't rewrite working code for style.
4. **Report the cost.** Each PR states net lines added and removed, why each new file or dependency is necessary, and what existing code or library was considered instead. A PR that mostly adds code should say why it could not be smaller.
5. **Dependencies are code too.** Add one only with a short ADR, prefer few and well-maintained ones, and remove any that stop earning their place. The exception that proves the rule: never hand-roll security- or correctness-critical primitives (cryptography, password hashing, payment handling, time zones, address and tax datasets). Use proven libraries.
6. **Tests are code too.** Each test must earn its place: test behaviour, not implementation; prefer property-based tests over piles of examples for rules like money and state machines; no snapshot sprawl; no tests that restate the code.
7. **Derive, don't duplicate.** Types, validation and OpenAPI come from the schemas. Don't hand-write what can be generated or derived, and don't write the same logic in two places.
8. **Comments and docs explain why, not what.** No filler comments, no boilerplate README sections, no generated prose that nobody needs.
9. **Stop when it feels big.** If a task needs far more code than expected, stop and ask. The design, the plan or the scope may be wrong.
10. **Enforced, not just hoped for.** CI checks unused code, exports and dependencies, duplication, complexity limits and bundle-size budgets (task 0.4). A failing check is fixed by deleting or simplifying code, not by loosening the check.

## What we're building
Free-commerce: an MIT-licensed, TypeScript-only, opinionated commerce platform for React, Next.js, TanStack Start and React Native (Expo) developers. Headless backend, typed SDK, copy-in UI components, merchant admin, and (later) Funnels and Automations built on a shared flow engine. Born from frustration with MedusaJS being over-configurable: **one good default path beats many options.**

**The name is provisional but settled for development.** We keep "Free-commerce" for now (no short invented or metaphor-based alternative cleared GitHub, npm, domain and trademark checks), and the name is designed to be cheap to change. See "Brand and renaming" below.

## Decisions (settled)
- **Name:** keep Free-commerce for now; rename mechanism in task 0.2a; final name confirmed at the gate in task 5.8, before the first npm publish.
- **Design first:** all user interface is designed in **canvas-agents** (an agentic AI design tool with MCP tools, built on an infinite canvas) and approved by Jon *before* any UI code is written. See "Design workflow".
- **Auth:** Better Auth behind an `AuthProvider` interface. Admin users and storefront customers are separate.
- **Workflows and timers:** in-house, and deliberately small. Saga runner with compensation for checkout; a minimal Postgres-backed scheduler (`tick()` plus a jobs table) for sweepers and later automations. No Temporal/Inngest-style dependency. Revisit if either grows beyond what its tests can comfortably cover.
- **UI kit:** copy-in registry (`<cli> add <component>`) as the primary route; logic stays in hooks and headless packages.
- **Funnel layouts:** developer-owned components with a content schema; the admin controls structure, rules and copy. No visual page builder.
- **First demo storefront:** Next.js. Expo second. The SDK must stay React Native-safe from day one (fetch only, no Node APIs).
- **Business model:** open source plus eventual hosted cloud. Don't make design choices that block it.
- **Providers:** Resend + SMTP for email, Twilio for SMS (later), each behind an interface.
- **Dogfooding:** a real store (Jon's) runs on v0.1 before the alpha is announced.

### Scope calls (recommended; adopted unless Jon overrides)
- **Product types in v0.1:** physical goods (simple and variable), digital downloads, services and donations, all as one-time payments. Each variant declares `deliveryType` (`physical | digital | none`), `priceMode` (`fixed | customer_defined`, for donations and pay-what-you-want), optional `quantityUnit` (e.g. "hour"; labelling only, no scheduling) and `taxCategory`.
- **Not in v0.1, but designed for:** subscriptions and recurring billing (Stripe Billing, Phase 8), memberships and entitlements (Phase 8), license keys and personalised products (Phase 6), bookings and scheduling (a plugin in Phase 9). Don't build them early, but don't make choices that block them (for example, never assume a one-time charge or a physical item).
- **Payments are not instant.** Checkout must handle 3D Secure and other customer authentication, redirect and wallet methods, and asynchronous methods (such as bank transfer). The checkout saga is resumable and driven by payment webhooks, with a reconciliation job as a safety net.
- **Developer platform basics in v0.1:** publishable and secret API keys, signed outbound webhooks with retries and a delivery log, CORS and session handling for cross-domain and mobile storefronts.
- **Documents:** invoices, receipts and credit notes for orders and refunds, with tax ID fields.
- **Abuse protection:** captcha provider interface, rate limits and lockouts on checkout, login and coupon endpoints, payment-attempt limits.
- **Merchant essentials:** guest order lookup, draft (manual) orders with manual payments, order notes and customer messages, new-order notifications, CSV import and export, dashboard sales metrics, store policies and checkout consent.
- **Storefront tracking:** a standard event layer (view item, add to cart, begin checkout, purchase and so on) with pluggable trackers (GA4, Meta Pixel), gated by cookie consent. Server-side conversion APIs follow in Phase 6.
- **One store per deployment.** No multi-store or multi-tenant model in v0.1. A hosted cloud runs many deployments. Keep tenant concerns out of `core`.
- **Multi-currency and regional pricing:** yes, from the start (money is always amount + currency).
- **i18n-ready, not translated.** All storefront and admin strings go through message catalogs (English default); formatting of money, dates and numbers uses `Intl`. Addresses follow country-specific formats using a maintained dataset. Translated product content is out of scope for v0.1.
- **Admin roles:** owner, staff, read-only, with permission checks on every admin route, plus an **audit log** of admin mutations.
- **Media and file storage:** a `StorageProvider` interface with local-disk and S3/R2-compatible implementations; public media with image variants, and private storage with signed URLs for digital assets.
- **Catalog search:** Postgres full-text search and filtering in v0.1 behind a `SearchProvider` interface (external engines later).
- **Transactional email in v0.1** (order confirmation, shipping notification, digital delivery, password reset, staff new-order notification) via the email provider interface; marketing automations stay in Phase 6.
- **Decision records:** every non-trivial design decision gets an ADR in `docs/adr/`.

## Brand and renaming
The product name may change before the first public release, so it must live in one place.
- `brand.json` at the repo root is the single source of truth: product name, slug, npm scope, CLI command, environment variable prefix, domain, repository URL. Current values: name `Free-commerce`, slug `free-commerce`, scope `@free-commerce`, env prefix `FREE_COMMERCE`.
- **Never hard-code the product name** in UI copy, error messages, generated files, CLI output or docs prose. Read it from `brand.json` through the helper in `packages/config`. Package names, imports and the CLI binary are the only places it must appear literally, and the rename script rewrites those.
- `pnpm rename --to <name> [--scope @x]` previews by default and applies with `--write` (task 0.2a). A CI check fails if a brand name appears outside `brand.json`, the ADR and the allowlist.
- Keep the rename machinery small (prime directive). Don't add logo, wordmark or name-specific visual identity to the design system until the name is confirmed.
- Do not publish anything to npm before the name gate in task 5.8.

## Assumed defaults (change if you disagree)
pnpm workspaces + Turborepo; TypeScript strict; Vitest; Playwright for end-to-end tests; Biome for lint and format; knip for unused code and dependencies; tsdown or tsup for package builds; Changesets for versioning; Zod 4 (Standard Schema compatible); Hono; Drizzle; Tailwind CSS 4; TanStack Query; OpenTelemetry for tracing; gitleaks for secret scanning; GitHub Actions CI. Supported browsers: the last two versions of evergreen browsers and iOS and Android versions as listed in the docs.

## Architecture rules
1. `core` is pure TypeScript. No I/O, no ORM, no HTTP, no Node-only APIs. It depends on repository and provider interfaces only.
2. Every database adapter must pass `adapter-testkit`. A feature isn't done until the in-memory adapter and the Postgres adapter both pass.
3. Schemas (Zod) are the single source of truth for types, validation and OpenAPI. Don't hand-write duplicate types.
4. Money is integer minor units plus an ISO 4217 currency code. Never floats.
5. Every mutating endpoint accepts an idempotency key. Inbound webhooks are verified and processed idempotently.
6. Checkout is a code-defined, resumable saga with compensation steps. Test the failure path of every step, including payment authentication, timeouts and delayed webhooks.
7. Funnels and Automations are graphs stored as data via the `flow` package (`@free-commerce/flow`). Presentation (funnel layouts, email templates) is code; copy is data.
8. The server must run on Node, Bun and edge runtimes. No hard dependency on a framework like NestJS.
9. Never handle raw card data. Hosted fields only.
10. Default first: every new setting or option needs a reason a real store would change it. If unsure, don't add it.
11. **No UI code without an approved design.** Every screen, component and flow is designed in canvas-agents first.
12. External services (payments, email, SMS, storage, search, auth, captcha) are always behind provider interfaces with a fake implementation for tests.
13. Personal data is minimised, exportable and deletable (GDPR). Never log secrets, tokens or full personal data.
14. Public API surface is explicit: mark exports `@public` or `@experimental`; only `@public` is covered by semver. Database migrations are per-module, forward-only and tested on upgrade from the previous release.
15. **Never assume a variant is physical or fixed-priced.** Shipping, stock, tax and fulfilment behaviour follows the variant's delivery type, price mode and tax category. Digital assets are never publicly addressable; they are delivered only through download grants and short-lived signed URLs.
16. Secrets (API secret keys, webhook secrets) are shown once at creation and stored hashed or encrypted. Plugins run in-process with full trust; document this rather than pretending to sandbox them.
17. **The product name lives in `brand.json`.** See "Brand and renaming".

## Review of security-critical work (🔒)
Tasks marked 🔒 in the plan touch money, authentication, payments, webhooks, signed URLs, personal data or the checkout saga. Before merging a 🔒 task:
- run an **independent review** in a fresh session that did not write the code, using the code review and security checklists, with the explicit brief to find bugs, vulnerabilities and unnecessary code;
- fix or explicitly accept every finding, recording acceptances in the PR;
- Jon reviews the PR.
Never give Claude Code production secrets; use test-mode keys and local services. Secret scanning runs in CI and as a pre-commit hook.

## Design workflow (canvas-agents)
Design and user experience are core to the product. The sequence for any user-facing work is **design, approve, implement, compare.**

1. **Design.** Before writing UI code, create or update the design in canvas-agents using its MCP tools. Work in the matching canvas (Design System, Admin, Storefront UI Kit, Funnel Layouts, Flow Editor, Email Templates, Docs Site). Design the states that matter, not only the happy path: empty, loading, error, long content, disabled, and mobile/tablet/desktop where relevant. Include light and dark where the design system supports both. Reuse existing components before designing new ones (the prime directive applies to design too).
2. **Approve.** Stop and ask Jon to review. Don't start implementation until he approves the specific frames. Record what was approved.
3. **Export the spec.** Put the design reference and any extracted decisions (tokens, spacing, component anatomy, interaction notes) in `docs/design/` and link the canvas frames. Tokens flow from the design system canvas into `packages/ui`; don't invent values in code.
4. **Implement.** Build to the approved design using the tokens and components from the design system. Keep a demo page for each component so it can be compared against the design.
5. **Compare.** After implementing, check the result against the frames (visually and for states and accessibility). Report differences. If the design needs to change, update it in canvas-agents and get approval again, then change the code.

If canvas-agents is not connected in your session, stop and say so; don't substitute your own UI design.

## Claude Code operations
- **One task per session.** Start a fresh session for each plan task; re-read this brief, the task, and any ADRs and docs it references. Don't carry assumptions across tasks.
- **Branches and PRs.** One branch per task (`task/1.3-inventory`), one PR per task, Conventional Commit messages. The PR description lists the task ID, acceptance criteria, how each was verified, and the net lines added and removed with justification for new files and dependencies.
- **Hooks.** Typecheck and lint run automatically after edits; tests for the touched package run before a commit; secret scanning runs before a commit. Configure these in task 0.1.
- **MCP servers.** canvas-agents (design), a Postgres server for inspecting dev data, and Stripe test-mode tooling when payments work starts. Add others only when a task needs them.
- **Record decisions.** When a task forces a design decision, write an ADR in `docs/adr/NNNN-title.md` (context, decision, consequences) in the same PR.
- **Keep this file lean.** Move detail to `docs/` and link it.

## Cross-cutting requirements (apply to every task)
- **Testing:** unit tests next to code (`*.test.ts`); property-based tests for money, pricing, inventory and state machines; adapter-testkit for storage; Playwright end-to-end tests for storefront checkout (physical, digital and donation) and core admin flows; contract tests proving the SDK matches the OpenAPI spec. Tests are code too (prime directive, point 6).
- **Observability:** structured JSON logging with request IDs, OpenTelemetry spans around saga steps and provider calls, health and readiness endpoints, typed error codes.
- **Security:** input validation at every boundary, rate limiting on auth, checkout and coupon endpoints, secrets only from validated env config, dependency audit and secret scanning in CI.
- **Accessibility:** WCAG 2.1 AA for all UI: contrast, keyboard navigation, focus states, touch target size, screen reader labels.
- **Docs:** public API additions need OpenAPI output and a docs entry in the same PR.
- **Assets:** demo images, fonts and icons must have licences that permit redistribution; record them in `docs/assets.md`.

## Conventions
- Package names `@free-commerce/<name>` (the scope comes from `brand.json` and can be changed with the rename script). Folder layout as in the architecture doc, section 5.
- IDs are prefixed and sortable (e.g. `prod_...`, `ord_...`).
- Timestamps are UTC, stored as timestamptz, serialized as ISO 8601.
- Small, focused commits. Contributions use DCO sign-off.

## Working agreement
- Work one task from `execution-plan.md` at a time, in order unless told otherwise. Tasks marked 🎨 have a design gate that must pass first; tasks marked 🔒 need independent review.
- Write tests first where practical. A task is done only when its acceptance criteria pass, typecheck, lint and the code-minimalism checks are clean, and `turbo run test` is green.
- Tick the task's checkbox in the plan and note anything that changes the design.
- **Stop and ask** before: changing a settled decision, adding a runtime dependency (always for `core`), changing the repository-interface shape after the testkit exists, adding public API not in the plan, starting any UI implementation without an approved design, publishing anything to npm, or when a task is turning out much larger than described.
- Prefer deleting scope to adding it. Flag anything that looks like scope creep.

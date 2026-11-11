# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo state

Pre-scaffold: only `docs/` exists (no code, no `package.json`, empty `README.md`). Build/lint/test commands do not exist yet; they arrive with task 0.2 (monorepo scaffold) and 0.4 (CI). Planned toolchain: pnpm workspaces + Turborepo, TypeScript strict, Vitest, Playwright, Biome, knip, Changesets. Intended single-test usage is Vitest per package (`turbo run test --filter=<pkg>`); update this section once the scaffold lands.

Source of truth for work: [docs/claude-code-brief.md](docs/claude-code-brief.md) (decisions, scope, rules, workflow) and [docs/execution-plan.md](docs/execution-plan.md) (ordered tasks with acceptance criteria). Read both before starting any task. The brief mentions `architecture-and-roadmap.md` and `domain-model-draft.md`, which are not in the repo yet; `docs/domain-model.md` is produced by task 0.7.

## What this is

Free-commerce: MIT-licensed, TypeScript-only, opinionated commerce platform (headless backend, typed SDK, copy-in UI registry, merchant admin, later Funnels/Automations on a shared `flow` engine). One good default path beats many options. One store per deployment; Next.js demo first, Expo second; the SDK must stay React Native-safe (fetch only, no Node APIs).

## Prime directive: less code, with purpose

Outranks every other convention. Try not to write code (simplify scope, use platform/stdlib/existing dependency first); write the smallest change meeting acceptance criteria; no speculative abstraction or unused options; delete dead code immediately. Every PR reports net lines added/removed and justifies each new file/dependency. Dependencies need a short ADR (except security/correctness primitives: never hand-roll crypto, payments, time zones, tax/address data). Tests must earn their place (behaviour, property-based for money/state machines). If a task needs far more code than expected, stop and ask. CI guardrails (knip, duplication, complexity, bundle budgets) are fixed by deleting code, never by loosening the check.

## Architecture rules

- `core` is pure TypeScript: no I/O, ORM, HTTP or Node-only APIs; depends only on repository/provider interfaces.
- Every DB adapter must pass `adapter-testkit`; a feature isn't done until in-memory and Postgres adapters both pass.
- Zod schemas are the single source of truth for types, validation and OpenAPI.
- Money = integer minor units + ISO 4217 currency; never floats.
- Every mutating endpoint takes an idempotency key; inbound webhooks verified and idempotent.
- Checkout is a code-defined, resumable saga with compensation (3DS, redirects, async payments, webhook-driven, reconciliation safety net). Test the failure path of every step.
- Funnels/Automations are graphs stored as data via `@free-commerce/flow`; presentation is code, copy is data.
- Server runs on Node, Bun and edge; no framework lock-in (no NestJS). Stack: Hono, Drizzle, Better Auth behind `AuthProvider`, Tailwind 4, TanStack Query.
- External services (payments, email, SMS, storage, search, auth, captcha) always sit behind provider interfaces with a fake for tests.
- Never assume a variant is physical or fixed-priced: shipping/stock/tax/fulfilment follow `deliveryType`, `priceMode`, `taxCategory`. Digital assets are only reachable via download grants and short-lived signed URLs.
- Never handle raw card data; secrets shown once and stored hashed/encrypted; never log secrets or full personal data; PII is exportable and deletable.
- Public exports marked `@public` or `@experimental`; migrations are per-module, forward-only, upgrade-tested.
- Every new setting needs a reason a real store would change it; otherwise don't add it.

## Brand

Product name is provisional and lives only in `brand.json` (read via helper in `packages/config`); never hard-code it in UI copy, errors, generated output or docs prose. Rename with `pnpm rename --to <name> [--scope @x]` (preview by default, `--write` to apply; task 0.2a). Do not publish to npm before the name gate (task 5.8).

## Design-first UI

No UI code without a design approved by Jon in canvas-agents (MCP). Sequence: design, approve, export spec to `docs/design/`, implement from tokens/components, compare. If canvas-agents isn't connected, stop and say so; don't invent UI design. Tasks marked 🎨 have this gate.

## Workflow

- One task per session; one branch per task (`task/1.3-inventory`); one PR per task; Conventional Commits; DCO sign-off. PR lists task ID, acceptance evidence, net lines, new file/dependency justification, and the 🔒 review record.
- 🔒 tasks (money, auth, payments, webhooks, signed URLs, personal data, saga) need an independent review in a fresh session before merge. Use test-mode keys only; never production secrets.
- Non-trivial design decisions get an ADR in `docs/adr/NNNN-title.md` in the same PR.
- A task is done only when acceptance criteria, typecheck, lint, minimalism checks and `turbo run test` pass; tick its checkbox in `execution-plan.md`.
- **Stop and ask** before: changing a settled decision, adding a runtime dependency (always for `core`), changing repository interfaces after the testkit exists, adding public API not in the plan, starting UI implementation without approved design, publishing to npm, or when a task balloons.

## Conventions

Packages `@free-commerce/<name>`; prefixed sortable IDs (`prod_...`, `ord_...`); timestamps UTC/timestamptz/ISO 8601; unit tests beside code (`*.test.ts`); WCAG 2.1 AA for UI; all strings through message catalogs; public API additions need OpenAPI and a docs entry in the same PR; demo asset licences recorded in `docs/assets.md`.

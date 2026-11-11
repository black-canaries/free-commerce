---
status: accepted
---
# Toolchain: pnpm, Turborepo, TypeScript, Biome, Vitest, knip, jscpd, Changesets

These are the defaults named in the brief, adopted as one decision so each dev dependency does not need its own ADR. All are dev-only; no runtime dependencies are added. Packages build with plain `tsc` (no bundler) until one is needed; tsdown/tsup is deferred to the first package that ships to npm. Playwright and bundle-size budgets are deferred to the first e2e test (4.8) and the first client package (3.1), so no config exists without code to run it on.

## Consequences

- Complexity limit is Biome's `noExcessiveCognitiveComplexity` (max 12); duplication is jscpd; unused code is knip.
- Docs (`docs/`, `*.md`) are excluded from Biome so prose is never reformatted.

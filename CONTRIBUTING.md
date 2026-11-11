# Contributing

## Prime directive: less code, with purpose
Every line must have a purpose. Before adding code, try to simplify the requirement or reuse the platform, the standard library or an existing dependency. Report net lines added and removed in the PR and justify each new file and dependency. CI guardrails (knip, duplication, complexity) are fixed by deleting code, never by loosening the check.

## Workflow
- One task per branch (`task/1.3-inventory`) and one PR per task, from [docs/execution-plan.md](docs/execution-plan.md).
- Conventional Commits, each signed off (`git commit -s`) under the [Developer Certificate of Origin](https://developercertificate.org/).
- Non-trivial decisions get an ADR in `docs/adr/`. New dependencies need one too.
- A task is done when its acceptance criteria, `pnpm typecheck`, `pnpm lint`, `pnpm knip` and `pnpm test` pass.
- Do not hard-code the product name; read it from `brand.json`.

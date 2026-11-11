# Versioning

- **Semver** via Changesets. Pre-1.0, a minor bump may break `@public` exports; patch never does.
- Exports are marked `@public` or `@experimental` in TSDoc. Only `@public` is covered by semver; `@experimental` can change in any release.
- **Deprecation window:** a `@public` export is marked `@deprecated` for at least one minor release before removal, with the replacement named.
- **Migrations** are per-module, forward-only and tested by upgrading from a seeded schema of the previous release. No down migrations.

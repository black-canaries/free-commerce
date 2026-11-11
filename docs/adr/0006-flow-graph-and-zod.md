---
status: accepted
---
# Flow graph model and zod in `packages/flow`

Funnels and Automations are graphs stored as data. `@free-commerce/flow` defines nodes (`trigger`, `condition`, `action`, `wait`), edges with optional branch labels, a structural validator (one trigger, no dangling edges, no duplicate ids, every node reachable) and a `draft` / `published` model: edits touch only the draft; `publish` validates, then freezes a copy as the next integer version. Node `config` is an opaque record; typed per-node schemas arrive with the runtime (Phase 3/4). Cycles are allowed (loops are valid); runtime guards belong to the engine.

`zod` (settled stack, pre-approved) is the only runtime dependency: schemas are the source of truth for types and validation. It is pure TypeScript and React Native-safe.

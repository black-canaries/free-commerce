---
status: accepted
---
# Roles, a central permission table and an append-only audit log

**Roles** (`owner`, `staff`, `read_only`) are rows in `roles` (`Repository<RoleAssignment>`, id = admin user id). No row means no access. A session's role is looked up per request; a secret API key acts as `staff` when it holds `admin:write`, else `read_only`, and never as owner, so keys cannot manage keys, team or the audit log.

**Permissions** live in one table in core (`ADMIN_GROUPS`: first `/admin/<segment>` to group; `GRANTS`: role to group to `read`/`write`). `can(role, path, access)` is deny-by-default: an unmapped segment, unknown role or missing grant refuses, owners included, so a route added without a table entry returns 403 until someone decides who may use it. `read` is GET/HEAD/OPTIONS, everything else is `write`. Owner: everything. Staff: read and write system, catalog, orders, discounts; read settings. Read-only: read the same, no writes. Keys, team and audit: owner only. The `authorize` middleware runs after `requireAdmin` (authentication, CSRF, key scope) and before idempotency.

**Audit** (`AuditRepository`: `append`, `list`; no update or delete): the `audited` middleware appends one entry for every admin mutation that succeeds (status below 400): actor (user or key id), `METHOD routePattern`, target, time. Handlers add before/after with `c.set("change", { target, before, after })`; both go through `summarize` (sensitive-looking keys masked, strings cut at 80 chars, depth 3, 20 keys) so entries never hold secrets or full personal data. Idempotent replays are not logged again. Entries are JSON documents (`audit`, newest first by time-sortable id, index on actor); `GET /admin/audit?actorId&limit&cursor`.

**Team**: `GET /admin/team`, `PUT /admin/team/:userId {role}` (owner only). The change runs in one transaction and refuses to demote the last owner (`409`), so two owners cannot lock the store out.

## Consequences

- Plain mutations are audited by the middleware after the handler (not atomic with it). The role change, the one privilege route here, writes its entry in the same transaction and sets `c.var.audited` so the middleware skips it; later handlers for money or key operations do the same through `tx.audit`.
- `PUT /team/:userId` needs an existing admin user (`AuthProvider.userExists`, added in this PR), and only existing users count towards "another owner", so a mistyped id cannot become the last owner.
- `summarize` masks by key name (a safety net, widened to address, free-text and credential names); handlers pass only ids, enums and statuses, never bodies or free text. The fallback target is the route pattern, not the raw path.
- Append-only is enforced in Postgres by a trigger refusing `UPDATE`/`DELETE` on `audit`. Deferred: same-millisecond entries have no stable order (ids are time-sortable with random tails), and denied attempts are not audited (request logs and rate limits cover them).
- The first owner has no route to create them: setup (5.x) or a seed script saves `{ id, role: "owner" }` through `db.roles`.
- Failed and denied attempts are not audited (rate limiting and request logs cover them).
- 1.14 adds its routes under existing segments or extends `ADMIN_GROUPS` in the same PR.

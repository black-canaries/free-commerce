import { newId } from "@free-commerce/schema";

export const ROLES = ["owner", "staff", "read_only"] as const;
export type Role = (typeof ROLES)[number];

/** @experimental One row per admin user (`id` is the auth user id). No row means no access. */
export interface RoleAssignment {
  id: string;
  role: Role;
}

export type Access = "read" | "write";

/**
 * The one table that says which `/admin/<segment>` belongs to which group. A segment not listed here is
 * denied to everyone, owners included, so a new route cannot ship open by accident.
 */
export const ADMIN_GROUPS = {
  ping: "system",
  products: "catalog",
  collections: "catalog",
  media: "catalog",
  "digital-assets": "catalog",
  inventory: "catalog",
  orders: "orders",
  customers: "orders",
  discounts: "discounts",
  shipping: "settings",
  tax: "settings",
  settings: "settings",
  webhooks: "settings",
  "api-keys": "keys",
  team: "team",
  audit: "audit",
} as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[keyof typeof ADMIN_GROUPS];

const everything = [
  "system",
  "catalog",
  "orders",
  "discounts",
  "settings",
  "keys",
  "team",
  "audit",
] as const;
const day = ["system", "catalog", "orders", "discounts"] as const;

/** What each role may do per group; absent means denied. Owner-only: keys, team, audit, settings writes. */
const GRANTS: Record<Role, Partial<Record<AdminGroup, readonly Access[]>>> = {
  owner: Object.fromEntries(everything.map((g) => [g, ["read", "write"]])),
  staff: {
    ...Object.fromEntries(day.map((g) => [g, ["read", "write"]])),
    settings: ["read"],
  },
  read_only: Object.fromEntries([...day, "settings"].map((g) => [g, ["read"]])),
};

/** `undefined` for a path outside `/admin/<known segment>`: deny. */
export const adminGroup = (path: string): AdminGroup | undefined => {
  const segment = /^\/admin\/([^/?]+)/.exec(path)?.[1];
  return segment && Object.hasOwn(ADMIN_GROUPS, segment)
    ? ADMIN_GROUPS[segment as keyof typeof ADMIN_GROUPS]
    : undefined;
};

/** Deny by default: unknown role, unmapped path or missing grant all refuse. */
export const can = (
  role: Role | null | undefined,
  path: string,
  access: Access,
): boolean => {
  const group = adminGroup(path);
  return !!role && !!group && !!GRANTS[role]?.[group]?.includes(access);
};

/** @experimental Who did it: an admin user or a secret API key. */
export interface AuditEntry {
  id: string;
  at: string;
  actor: { type: "user" | "key"; id: string };
  /** `<METHOD> <route pattern>`, e.g. `PUT /admin/team/:userId`. */
  action: string;
  /** What was touched, e.g. `team/usr_...`. */
  target: string;
  /** Redacted, size-bounded summaries (see `summarize`); never raw bodies. */
  before?: unknown;
  after?: unknown;
}

/** @experimental Append-only: no update, no delete. */
export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>;
  /** Newest first (by id, which sorts by time); `cursor` is the last id of the previous page. */
  list(query: {
    limit: number;
    cursor?: string;
    actorId?: string;
  }): Promise<{ items: AuditEntry[]; nextCursor: string | null }>;
}

const SENSITIVE =
  /pass|pwd|secret|token|hash|key|card|cvv|iban|account|email|phone|mobile|address|street|city|zip|post|line\d|name|birth|dob|ssn|otp|jwt|signature|session|authorization|cookie|note|comment|message|body|text|description/i;
const MAX_STRING = 80;
const MAX_KEYS = 20;
const MAX_DEPTH = 3;

/**
 * Bounded, redacted copy for audit entries: sensitive-looking keys are masked, long strings cut,
 * depth and width capped. A deny-list is only a safety net: handlers must pass just the fields they mean to log
 * (ids, statuses, enums), never request bodies or free text.
 */
export const summarize = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string")
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, MAX_KEYS).map((v) => summarize(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_KEYS)
      .map(([k, v]) => [
        k,
        SENSITIVE.test(k) ? "[redacted]" : summarize(v, depth + 1),
      ]),
  );
};

export const newAuditEntry = (
  input: Omit<AuditEntry, "id" | "at" | "before" | "after"> & {
    before?: unknown;
    after?: unknown;
  },
  now: number,
): AuditEntry => ({
  ...input,
  id: newId("aud", now),
  at: new Date(now).toISOString(),
  before: input.before === undefined ? undefined : summarize(input.before),
  after: input.after === undefined ? undefined : summarize(input.after),
});

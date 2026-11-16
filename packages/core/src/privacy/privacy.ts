import type { Customer } from "@free-commerce/schema";
import { type AuditEntry, newAuditEntry } from "../access/access";
import type { AuthProvider } from "../providers/auth";
import type { Database, Entity, Repositories } from "../repositories";

/**
 * @experimental A store of personal data owned by a later module (e.g. download grants with guest emails).
 * Register it in `PersonalDataDeps.hooks`: `export` joins the customer's export under `name`, `erase` runs
 * inside the erasure transaction. Both MUST be idempotent and secret-free.
 */
export interface PersonalDataHook {
  name: string;
  export(customerId: string, tx: Repositories): Promise<unknown>;
  erase(customerId: string, tx: Repositories): Promise<void>;
}

/** @experimental */
export interface PersonalDataDeps {
  db: Database;
  auth: AuthProvider;
  hooks?: PersonalDataHook[];
  now: () => number;
}

/** @experimental Who asked; recorded on the audit entry (ids only, never personal data). */
export type PrivacyActor = AuditEntry["actor"];

/** @experimental */
export class PrivacyError extends Error {
  readonly code = "not_found";
  constructor() {
    super("Customer not found");
  }
}

const load = async (db: Pick<Repositories, "customers">, id: string) => {
  const customer = await db.customers.get(id);
  if (!customer) throw new PrivacyError();
  return customer;
};

const audit = (
  d: PersonalDataDeps,
  actor: PrivacyActor,
  what: string,
  id: string,
) =>
  newAuditEntry(
    { actor, action: `privacy.${what}`, target: `customers/${id}` },
    d.now(),
  );

/**
 * @experimental Everything held about one customer, as JSON: profile, saved addresses, orders and each
 * hook's data. Looks up by `customerId` only, so a caller can never reach another customer's rows. Never
 * includes auth credentials or sessions, or internal refund fingerprints. Orders keep `paymentId`: it is the customer's own payment reference, not a secret. The export is audited first: if
 * the audit write fails nothing is released.
 */
export async function exportCustomerData(
  d: PersonalDataDeps,
  customerId: string,
  actor: PrivacyActor,
) {
  const customer = await load(d.db, customerId);
  await d.db.audit.append(audit(d, actor, "export", customerId));
  const addresses = (await d.db.addresses.listByCustomer(customerId)).map(
    ({ customerId: _owner, ...address }) => address,
  );
  const orders = (await d.db.orders.listByCustomer(customerId)).map(
    ({ refunds: _fingerprints, ...order }: Record<string, unknown>) => order,
  );
  const extra = Object.fromEntries(
    await Promise.all(
      (d.hooks ?? []).map(
        async (h) => [h.name, await h.export(customerId, d.db)] as const,
      ),
    ),
  );
  return {
    exportedAt: new Date(d.now()).toISOString(),
    customer,
    addresses,
    orders,
    extra,
  };
}

const ANONYMOUS = {
  email: null,
  name: null,
  phone: null,
  taxId: null,
  defaultAddressId: null,
} as const satisfies Partial<Customer>;

/**
 * @experimental Anonymises a customer: nulls the profile PII, deletes addresses, drops the owner link from
 * orders (amounts, tax and lines stay, so accounting is intact), runs hooks, audits and queues
 * `customer.anonymised` (id only), all in one transaction. Then the auth account and its sessions are
 * removed (idempotent): a crash in between leaves anonymised data with a login that a retry removes, never
 * a locked-out customer with intact data. Repeating it is a no-op returning `erased: false`. A login with
 * no customer row (registered before rows existed) is removed too.
 */
export async function eraseCustomer(
  d: PersonalDataDeps,
  customerId: string,
  actor: PrivacyActor,
): Promise<{ erased: boolean }> {
  if (!(await d.db.customers.get(customerId))) {
    // An account registered before customer rows existed: nothing is stored but the login, so remove that.
    if (!(await d.auth.userExists("customer", customerId)))
      throw new PrivacyError();
    await d.auth.deleteUser("customer", customerId);
    return { erased: false };
  }
  const result = await d.db.transaction(async (tx) => {
    const customer = await load(tx, customerId);
    if (customer.anonymisedAt !== null) return { erased: false };
    await tx.addresses.deleteByCustomer(customerId);
    for (const order of await tx.orders.listByCustomer(customerId)) {
      const { customerId: _owner, ...rest } = order as Entity & {
        customerId?: string;
      };
      await tx.orders.save(rest);
    }
    for (const h of d.hooks ?? []) await h.erase(customerId, tx);
    const at = new Date(d.now()).toISOString();
    await tx.customers.save({ ...customer, ...ANONYMOUS, anonymisedAt: at });
    await tx.outbox.add({
      id: `customer.anonymised:${customerId}`,
      type: "customer.anonymised",
      occurredAt: at,
      payload: { customerId },
    });
    await tx.audit.append(audit(d, actor, "erase", customerId));
    return { erased: true };
  });
  // After the commit: if this fails the data is already gone and a retry (idempotent) finishes the login.
  await d.auth.deleteUser("customer", customerId);
  return result;
}

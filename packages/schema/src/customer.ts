import { z } from "zod";
import { AddressId } from "./address.js";
import { idSchema } from "./id.js";
import { Timestamp } from "./time.js";

export const CustomerId = idSchema("cus");

/** Tax identifier (e.g. VAT number); `type` is a free label such as `eu_vat` or `br_cnpj`. */
export const TaxId = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
});
export type TaxId = z.infer<typeof TaxId>;

/**
 * A guest is identified by email only; a registered customer also has an auth identity.
 * Personal fields are listed in `CUSTOMER_PII_FIELDS`; anonymisation (task 2.9) nulls exactly those, sets
 * `anonymisedAt`, and deletes the customer's addresses (`Address` is entirely personal data).
 */
export const Customer = z.object({
  id: CustomerId,
  kind: z.enum(["guest", "registered"]),
  email: z.email(),
  name: z.string().trim().min(1).nullable(),
  phone: z.string().trim().min(1).nullable(),
  taxId: TaxId.nullable(),
  defaultAddressId: AddressId.nullable(),
  createdAt: Timestamp,
  anonymisedAt: Timestamp.nullable(),
});
export type Customer = z.infer<typeof Customer>;

export const CUSTOMER_PII_FIELDS = [
  "email",
  "name",
  "phone",
  "taxId",
] as const satisfies readonly (keyof Customer)[];

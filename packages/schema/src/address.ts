import { z } from "zod";
import { idSchema } from "./id.js";

export const AddressId = idSchema("addr");

/**
 * Postal address. All fields are personal data. Country-specific rules (postal-code format, required
 * region) live in `@free-commerce/address`; this schema only checks shape. `region` is the state,
 * province or prefecture (code or name).
 */
export const Address = z.object({
  id: AddressId,
  name: z.string().trim().min(1),
  company: z.string().trim().min(1).optional(),
  line1: z.string().trim().min(1),
  line2: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1),
  region: z.string().trim().min(1).optional(),
  postalCode: z.string().trim().min(1).optional(),
  country: z.string().regex(/^[A-Z]{2}$/), // ISO 3166-1 alpha-2
  phone: z.string().trim().min(1).optional(),
});
export type Address = z.infer<typeof Address>;

import { z } from "zod";
import { VariantId } from "./catalog.js";
import { idSchema } from "./id.js";
import { Timestamp } from "./time.js";

export const ReservationId = idSchema("rsv");

/** On-hand units of one variant. Negative only when backordered units were committed (units owed). */
export const StockLevel = z.strictObject({
  variantId: VariantId,
  quantity: z.number().int(),
});
export type StockLevel = z.infer<typeof StockLevel>;

export const ReservationStatus = z.enum(["active", "committed", "released"]);

/** Units of one variant held for a cart until `expiresAt`; only `active`, unexpired ones count as held. */
export const Reservation = z.strictObject({
  id: ReservationId,
  variantId: VariantId,
  cartId: z.string().min(1),
  quantity: z.number().int().positive(),
  expiresAt: Timestamp,
  status: ReservationStatus,
});
export type Reservation = z.infer<typeof Reservation>;

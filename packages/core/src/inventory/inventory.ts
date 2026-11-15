import {
  newId,
  Reservation,
  toTimestamp,
  type Variant,
} from "@free-commerce/schema";
import type { InventoryRepository, SettleResult } from "../repositories";

/**
 * @experimental The one transition rule, shared by adapters so `settle` is identical everywhere:
 * settling to the current state is a no-op success (idempotent); committed and released are final
 * (`conflict`); an expired reservation cannot be committed (its units may be sold) but can be released.
 */
export function decideSettle(
  r: Reservation | undefined,
  to: "committed" | "released",
  now: string,
): SettleResult {
  if (!r) return { ok: false, reason: "not_found" };
  if (r.status === to) return { ok: true, reservation: r };
  if (r.status !== "active") return { ok: false, reason: "conflict" };
  if (to === "committed" && r.expiresAt <= now)
    return { ok: false, reason: "expired" };
  return { ok: true, reservation: { ...r, status: to } };
}

/** @experimental `unmanaged`: the variant does not manage inventory, so nothing was reserved. */
export type ReserveOutcome =
  | { status: "reserved"; reservation: Reservation }
  | { status: "insufficient" | "unmanaged" };

/** @experimental Inventory service over an `InventoryRepository`; time comes only from `now`. */
export function createInventory(repo: InventoryRepository, now: () => Date) {
  const stamp = () => toTimestamp(now());
  return {
    setStock: (variantId: string, quantity: number) =>
      repo.setStock({ variantId, quantity }),

    /** On-hand minus units held by active, unexpired reservations. */
    async available(variantId: string): Promise<number> {
      const stock = await repo.getStock(variantId);
      return (stock?.quantity ?? 0) - (await repo.reserved(variantId, stamp()));
    },

    /** Passing the same `id` again retries safely and returns the original reservation. */
    async reserve(input: {
      variant: Variant;
      cartId: string;
      quantity: number;
      ttlMs: number;
      id?: string;
    }): Promise<ReserveOutcome> {
      const { variant } = input;
      if (!variant.manageInventory) return { status: "unmanaged" };
      const at = now();
      const draft = Reservation.parse({
        id: input.id ?? newId("rsv", at.getTime()),
        variantId: variant.id,
        cartId: input.cartId,
        quantity: input.quantity,
        expiresAt: toTimestamp(new Date(at.getTime() + input.ttlMs)),
        status: "active",
      });
      const reservation = await repo.reserve(
        draft,
        toTimestamp(at),
        variant.allowBackorder,
      );
      return reservation
        ? { status: "reserved", reservation }
        : { status: "insufficient" };
    },

    /** Consumes the held units from stock exactly once; repeating it is a safe no-op. */
    commit: (id: string) => repo.settle(id, "committed", stamp()),
    /** Frees the held units; repeating it is a safe no-op; rejected after commit. */
    release: (id: string) => repo.settle(id, "released", stamp()),
  };
}

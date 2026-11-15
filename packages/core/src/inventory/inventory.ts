import {
  newId,
  Reservation,
  StockLevel,
  toTimestamp,
  type Variant,
} from "@free-commerce/schema";
import type {
  InventoryRepository,
  ReserveResult,
  SettleResult,
} from "../repositories";

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

/**
 * @experimental Rule for `reserve` with an id that already exists, shared by adapters: succeed only when
 * the stored row is still an active, unexpired hold identical in variant, cart and quantity; a released,
 * committed, expired or different request is a `conflict`, never a silent "reserved".
 */
export function decideReserveRetry(
  stored: Reservation,
  draft: Omit<Reservation, "status">,
  now: string,
): ReserveResult {
  const same =
    stored.status === "active" &&
    stored.expiresAt > now &&
    stored.variantId === draft.variantId &&
    stored.cartId === draft.cartId &&
    stored.quantity === draft.quantity;
  return same
    ? { ok: true, reservation: { ...stored } }
    : { ok: false, reason: "conflict" };
}

/** @experimental `unmanaged`: the variant does not manage inventory, so nothing was reserved. */
export type ReserveOutcome =
  | { status: "reserved"; reservation: Reservation }
  | { status: "insufficient" | "conflict" | "unmanaged" };

/** @experimental Inventory service over an `InventoryRepository`; time comes only from `now`. */
export function createInventory(repo: InventoryRepository, now: () => Date) {
  const stamp = () => toTimestamp(now());
  return {
    setStock: async (variantId: string, quantity: number) =>
      repo.setStock(StockLevel.parse({ variantId, quantity })),

    /** On-hand minus units held by active, unexpired reservations. */
    async available(variantId: string): Promise<number> {
      const stock = await repo.getStock(variantId);
      return (stock?.quantity ?? 0) - (await repo.reserved(variantId, stamp()));
    },

    /**
     * Passing the same `id` again retries safely: the original reservation comes back while it is still
     * live and identical, otherwise `conflict`. `ttlMs` must be a positive integer.
     */
    async reserve(input: {
      variant: Variant;
      cartId: string;
      quantity: number;
      ttlMs: number;
      id?: string;
    }): Promise<ReserveOutcome> {
      const { variant } = input;
      if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0)
        throw new RangeError("ttlMs must be a positive integer");
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
      const out = await repo.reserve(
        draft,
        toTimestamp(at),
        variant.allowBackorder,
      );
      return out.ok
        ? { status: "reserved", reservation: out.reservation }
        : { status: out.reason };
    },

    /** Consumes the held units from stock exactly once; repeating it is a safe no-op. */
    commit: (id: string) => repo.settle(id, "committed", stamp()),
    /** Frees the held units; repeating it is a safe no-op; rejected after commit. */
    release: (id: string) => repo.settle(id, "released", stamp()),
  };
}

import { describe, expect, it } from "vitest";
import { newCart } from "../cart/cart";
import type { ShippingProvider } from "./shipping";

/** @experimental Every `ShippingProvider` must return well-formed options for a cart in `currency`. */
export function shippingConformance(
  name: string,
  make: () => ShippingProvider,
  currency: string,
): void {
  describe(`ShippingProvider conformance: ${name}`, () => {
    it("returns options with unique ids and non-negative integer amounts", async () => {
      const options = await make().quote({
        cart: newCart(currency),
        weightGrams: 100,
      });
      expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
      for (const o of options) {
        expect(Number.isInteger(o.amount)).toBe(true);
        expect(o.amount).toBeGreaterThanOrEqual(0);
        expect(o.label).not.toBe("");
      }
    });
  });
}

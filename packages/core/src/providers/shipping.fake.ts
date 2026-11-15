import { ProviderError } from "./error";
import type { ShippingOption, ShippingProvider } from "./shipping";

/** @experimental Fixed-options `ShippingProvider` for tests; `failing` makes `quote` throw an `unavailable` error. */
export function createFakeShipping(
  options: ShippingOption[] = [{ id: "fake", label: "Fake", amount: 500 }],
  failing = false,
): ShippingProvider {
  return {
    async quote() {
      if (failing)
        throw new ProviderError("fake-shipping", "unavailable", "down");
      return options.map((o) => ({ ...o }));
    },
  };
}

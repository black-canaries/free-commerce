import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PricingError, resolvePrice } from "./pricing";

const fixed = {
  prices: [
    { currency: "USD", amount: 1200 },
    { currency: "EUR", amount: 1100 },
  ],
};
const pwyw = {
  prices: [{ currency: "USD", min: 500, max: 5000, suggested: 1000 }],
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PricingError) return e.code;
  }
};

describe("resolvePrice", () => {
  it("resolves per currency, falling back only when asked", () => {
    expect(resolvePrice(fixed, "EUR")).toEqual({
      amount: 1100,
      currency: "EUR",
    });
    expect(resolvePrice(fixed, "GBP", { fallbackCurrency: "USD" })).toEqual({
      amount: 1200,
      currency: "USD",
    });
    expect(code(() => resolvePrice(fixed, "GBP"))).toBe("no_price");
  });

  it("requires an amount for customer-defined", () => {
    expect(code(() => resolvePrice(pwyw, "USD"))).toBe("amount_required");
  });

  it("honours the provider minimum over a lower min", () => {
    expect(
      code(() =>
        resolvePrice(pwyw, "USD", { chosenAmount: 500, providerMinimum: 600 }),
      ),
    ).toBe("out_of_bounds");
    expect(
      resolvePrice(pwyw, "USD", { chosenAmount: 600, providerMinimum: 600 })
        .amount,
    ).toBe(600);
  });

  it("accepts exactly the amounts in [max(min, providerMin), max]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 6000 }),
        fc.integer({ min: 0, max: 1000 }),
        (amount, providerMinimum) => {
          const ok = amount >= Math.max(500, providerMinimum) && amount <= 5000;
          const run = () =>
            resolvePrice(pwyw, "USD", {
              chosenAmount: amount,
              providerMinimum,
            });
          if (ok) expect(run()).toEqual({ amount, currency: "USD" });
          else expect(code(run)).toBe("out_of_bounds");
        },
      ),
    );
  });

  it("rejects non-integer amounts and never returns a float", () => {
    fc.assert(
      fc.property(fc.double({ min: 500, max: 5000, noInteger: true }), (n) => {
        expect(code(() => resolvePrice(pwyw, "USD", { chosenAmount: n }))).toBe(
          "out_of_bounds",
        );
      }),
    );
  });
});

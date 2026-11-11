import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  add,
  allocate,
  Money,
  minorUnitExponent,
  multiply,
  subtract,
} from "./money.js";

const amount = fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 });
const ratios = fc
  .array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 })
  .filter((r) => r.some((x) => x > 0));

describe("allocate", () => {
  it("never loses or invents a minor unit", () => {
    fc.assert(
      fc.property(amount, ratios, (a, r) => {
        const parts = allocate({ amount: a, currency: "USD" }, r);
        expect(parts.reduce((s, p) => s + p.amount, 0)).toBe(a);
        expect(parts).toHaveLength(r.length);
      }),
    );
  });

  it("each part is within one unit of its exact share; zero ratios get zero", () => {
    fc.assert(
      fc.property(amount, ratios, (a, r) => {
        const sum = r.reduce((s, x) => s + x, 0);
        allocate({ amount: a, currency: "USD" }, r).forEach((p, i) => {
          expect(Math.abs(p.amount - (a * (r[i] ?? 0)) / sum)).toBeLessThan(1);
          if (r[i] === 0) expect(p.amount).toBe(0);
        });
      }),
    );
  });

  it("splits 100 three ways as 34/33/33", () => {
    expect(
      allocate({ amount: 100, currency: "EUR" }, [1, 1, 1]).map(
        (p) => p.amount,
      ),
    ).toEqual([34, 33, 33]);
  });

  it("rejects empty, negative, fractional or all-zero ratios", () => {
    const m = { amount: 1, currency: "USD" };
    for (const bad of [[], [-1, 2], [0.5], [0, 0]])
      expect(() => allocate(m, bad)).toThrow(RangeError);
  });
});

describe("add / subtract / multiply", () => {
  it("add and subtract are inverse", () => {
    fc.assert(
      fc.property(amount, amount, (a, b) => {
        const x = { amount: a, currency: "USD" };
        const y = { amount: b, currency: "USD" };
        expect(subtract(add(x, y), y)).toEqual(x);
      }),
    );
  });

  it("rejects mixed currencies", () => {
    expect(() =>
      add({ amount: 1, currency: "USD" }, { amount: 1, currency: "EUR" }),
    ).toThrow(TypeError);
  });

  it("multiply rounds half away from zero and always yields an integer", () => {
    expect(multiply({ amount: 5, currency: "USD" }, 0.5).amount).toBe(3);
    expect(multiply({ amount: -5, currency: "USD" }, 0.5).amount).toBe(-3);
    fc.assert(
      fc.property(
        amount,
        fc.double({ min: 0, max: 5, noNaN: true }),
        (a, f) => {
          expect(
            Number.isInteger(
              multiply({ amount: a, currency: "USD" }, f).amount,
            ),
          ).toBe(true);
        },
      ),
    );
  });
});

describe("Money schema / exponent", () => {
  it("rejects floats and bad currency codes", () => {
    expect(Money.safeParse({ amount: 1.5, currency: "USD" }).success).toBe(
      false,
    );
    expect(Money.safeParse({ amount: 1, currency: "usd" }).success).toBe(false);
    expect(Money.safeParse({ amount: 1, currency: "USD" }).success).toBe(true);
  });

  it("knows minor-unit exponents", () => {
    expect([
      minorUnitExponent("JPY"),
      minorUnitExponent("USD"),
      minorUnitExponent("KWD"),
    ]).toEqual([0, 2, 3]);
  });
});

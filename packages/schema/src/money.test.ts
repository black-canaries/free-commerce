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

  it("multiply is exact, rounds half away from zero and never returns -0", () => {
    const u = (amount: number) => ({ amount, currency: "USD" });
    expect(multiply(u(5), 1, 2).amount).toBe(3);
    expect(multiply(u(-5), 1, 2).amount).toBe(-3);
    expect(multiply(u(1000), 825, 10000).amount).toBe(83);
    expect(Object.is(multiply(u(-1), 3, 10).amount, 0)).toBe(true);
    expect(multiply(u(7), 3).amount).toBe(21);
    for (const bad of [
      [1.5, 1],
      [1, 0],
      [1, -2],
      [Number.NaN, 1],
    ] as const)
      expect(() => multiply(u(1), bad[0], bad[1])).toThrow(RangeError);
    fc.assert(
      fc.property(
        amount,
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (a, n, d) => {
          const r = multiply(u(a), n, d).amount;
          expect(Math.abs(r - (a * n) / d)).toBeLessThanOrEqual(0.5 + 1e-6);
          expect(Object.is(r, -0)).toBe(false);
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

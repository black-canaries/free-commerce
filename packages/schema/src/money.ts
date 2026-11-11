import { z } from "zod";

/** ISO 4217 alphabetic code. Format-checked only; the currency list is owned by ISO, not by us. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** Integer minor units + currency. Never a float. */
export const Money = z.object({
  // `+ 0` turns -0 into 0.
  amount: z
    .number()
    .int()
    .transform((n) => n + 0),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;

/** ISO 4217 minor-unit exponents that differ from the default of 2 (ISO 4217 amendment tables). */
const EXPONENTS: Record<string, number> = {
  // 0 decimals
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // 3 decimals
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // 4 decimals
  CLF: 4,
  UYW: 4,
};

/**
 * Number of decimal places between major and minor units (JPY 0, USD 2, KWD 3). Display-scoped:
 * payment providers may scale some currencies differently, so payment code must take the provider's
 * rules for amounts it sends, not this table.
 */
export const minorUnitExponent = (currency: CurrencyCode): number =>
  EXPONENTS[currency] ?? 2;

const safe = (amount: number, currency: CurrencyCode): Money => {
  if (!Number.isSafeInteger(amount))
    throw new RangeError("Money amount out of safe integer range");
  return { amount: amount + 0, currency }; // `+ 0` turns -0 into 0
};

const wholeAmount = (m: Money): bigint => {
  if (!Number.isSafeInteger(m.amount))
    throw new RangeError("Money amount must be a safe integer");
  return BigInt(m.amount);
};

const sameCurrency = (a: Money, b: Money): void => {
  if (a.currency !== b.currency)
    throw new TypeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
};

export const add = (a: Money, b: Money): Money => {
  sameCurrency(a, b);
  return safe(a.amount + b.amount, a.currency);
};

/**
 * Multiply by the exact rational `numerator / denominator` (quantity: `multiply(m, 3)`; 8.25% rate:
 * `multiply(m, 825, 10000)`), rounding half away from zero to a whole minor unit. Integer-only on
 * purpose: float rates can land just under a .5 boundary and round the wrong way.
 */
export const multiply = (
  m: Money,
  numerator: number,
  denominator = 1,
): Money => {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  )
    throw new RangeError(
      "Factor must be an integer numerator over a positive integer denominator",
    );
  const n = wholeAmount(m) * BigInt(numerator);
  const d = BigInt(denominator);
  const abs = n < 0n ? -n : n;
  const q = Number((2n * abs + d) / (2n * d));
  return safe(n < 0n ? -q : q, m.currency);
};

/**
 * Split into `ratios.length` parts proportional to the non-negative integer ratios, using the
 * largest-remainder method. Parts always sum exactly to `m.amount` (no cent lost or invented);
 * ties go to the earlier index.
 */
export const allocate = (m: Money, ratios: readonly number[]): Money[] => {
  if (
    ratios.length === 0 ||
    !ratios.every((r) => Number.isSafeInteger(r) && r >= 0)
  ) {
    throw new RangeError(
      "Ratios must be a non-empty list of non-negative integers",
    );
  }
  const sum = ratios.reduce((s, r) => s + BigInt(r), 0n);
  if (sum === 0n) throw new RangeError("Ratios must not all be zero");
  const total = wholeAmount({ ...m, amount: Math.abs(m.amount) });
  const shares = ratios.map((r) => ({
    floor: (total * BigInt(r)) / sum,
    rem: (total * BigInt(r)) % sum,
  }));
  const leftover = Number(total - shares.reduce((s, p) => s + p.floor, 0n));
  const order = shares
    .map((p, i) => ({ i, rem: p.rem }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  const extra = new Set(order.slice(0, leftover).map((o) => o.i));
  const sign = m.amount < 0 ? -1 : 1;
  return shares.map((p, i) =>
    safe(sign * (Number(p.floor) + (extra.has(i) ? 1 : 0)), m.currency),
  );
};

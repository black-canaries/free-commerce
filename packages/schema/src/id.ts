import { z } from "zod";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, sorts lexicographically
const PREFIX = /^[a-z]{2,6}$/;

const assertPrefix = (prefix: string): void => {
  if (!PREFIX.test(prefix))
    throw new RangeError("ID prefix must be 2-6 lowercase letters");
};

/** Matches `<prefix>_<10 char timestamp><16 char random>` (ULID body); same prefix rule as `newId`. */
export const idSchema = (prefix: string) => {
  assertPrefix(prefix);
  return z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
};

/**
 * Prefixed ID (e.g. `prod_01J...`): 48-bit ms timestamp then 80 random bits, ULID layout. IDs sort by
 * creation time only to the millisecond; order within one ms is random.
 * Uses the Web Crypto `getRandomValues` global (Node, Bun, edge). React Native/Hermes has none:
 * apps must install a polyfill (`expo-crypto` or `react-native-get-random-values`) first.
 */
export const newId = (prefix: string, now: number = Date.now()): string => {
  assertPrefix(prefix);
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48)
    throw new RangeError("now must be an integer ms timestamp in [0, 2^48)");
  if (typeof globalThis.crypto?.getRandomValues !== "function")
    throw new Error(
      "crypto.getRandomValues is unavailable; install a polyfill (see newId docs)",
    );
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32))
    time = ALPHABET[t % 32] + time;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (const b of bytes) random += ALPHABET[b % 32];
  return `${prefix}_${time}${random}`;
};

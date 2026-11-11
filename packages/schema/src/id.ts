import { z } from "zod";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, sorts lexicographically
const PREFIX = /^[a-z]{2,6}$/;

/** Matches `<prefix>_<10 char timestamp><16 char random>` (ULID body). */
export const idSchema = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));

/**
 * Prefixed, time-sortable ID (e.g. `prod_01J...`): 48-bit ms timestamp then 80 random bits, ULID layout.
 * Uses the Web Crypto `getRandomValues` global (Node, Bun, edge, Expo).
 */
export const newId = (prefix: string, now: number = Date.now()): string => {
  if (!PREFIX.test(prefix))
    throw new RangeError("ID prefix must be 2-6 lowercase letters");
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32))
    time = ALPHABET[t % 32] + time;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (const b of bytes) random += ALPHABET[b % 32];
  return `${prefix}_${time}${random}`;
};

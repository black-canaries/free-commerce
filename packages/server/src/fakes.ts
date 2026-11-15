import type {
  IdempotencyEntry,
  IdempotencyStore,
  Logger,
  RateLimitStore,
  Tracer,
} from "./types.js";

/** Fakes for tests and single-process dev. Unbounded and not shared across instances: not for production. */
export const memoryIdempotencyStore = (): IdempotencyStore => {
  const map = new Map<string, IdempotencyEntry>();
  return {
    claim: async (key, fingerprint) => {
      const existing = map.get(key);
      if (!existing) map.set(key, { fingerprint, response: null });
      return existing;
    },
    complete: async (key, response) => {
      const entry = map.get(key);
      if (entry) entry.response = response;
    },
    release: async (key) => {
      map.delete(key);
    },
  };
};

export const memoryRateLimitStore = (
  now: () => number = Date.now,
): RateLimitStore => {
  const map = new Map<string, { count: number; resetAt: number }>();
  return {
    hit: async (key, windowMs) => {
      const t = now();
      const prev = map.get(key);
      const entry =
        prev && prev.resetAt > t
          ? { count: prev.count + 1, resetAt: prev.resetAt }
          : { count: 1, resetAt: t + windowMs };
      map.set(key, entry);
      return entry;
    },
  };
};

export const consoleLogger: Logger = (entry) =>
  console.log(JSON.stringify(entry));

export const noopTracer: Tracer = {
  startSpan: () => ({ setAttribute() {}, end() {} }),
};

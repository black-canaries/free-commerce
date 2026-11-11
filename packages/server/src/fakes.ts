import type {
  IdempotencyStore,
  Logger,
  RateLimitStore,
  StoredResponse,
  Tracer,
} from "./types.js";

/** Fakes for tests and single-process dev. Unbounded and not shared across instances: not for production. */
export const memoryIdempotencyStore = (): IdempotencyStore => {
  const map = new Map<string, StoredResponse>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
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

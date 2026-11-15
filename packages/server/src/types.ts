import type { ApiKey } from "@free-commerce/core";

export type LogEntry = Record<string, unknown>;
/** Receives one structured entry per call; the default writes a JSON line to the console. */
export type Logger = (entry: LogEntry) => void;

type Attr = string | number | boolean;
export interface Span {
  setAttribute(key: string, value: Attr): void;
  end(): void;
}
/** Structural tracer: an OpenTelemetry adapter is a few lines (see ADR 0011). No-op by default. */
export interface Tracer {
  startSpan(name: string, attributes?: Record<string, Attr>): Span;
}

export interface StoredResponse {
  status: number;
  contentType: string;
  body: string;
}
/** `response` is null while the first request is still running. */
export interface IdempotencyEntry {
  fingerprint: string;
  response: StoredResponse | null;
}
/** Keys passed in are already scoped to the caller; stores must not interpret them. */
export interface IdempotencyStore {
  /**
   * Atomically claims `key` for this request: resolves `undefined` if the caller now owns it, otherwise the
   * existing entry. Two concurrent first requests can never both be told they own the key.
   */
  claim(
    key: string,
    fingerprint: string,
  ): Promise<IdempotencyEntry | undefined>;
  /** Stores the response of the owner so later requests replay it. */
  complete(key: string, response: StoredResponse): Promise<void>;
  /** Gives the key up (5xx or crash) so the client can retry. */
  release(key: string): Promise<void>;
}

export interface RateLimitStore {
  /** Count a hit in the fixed window containing now; returns the count and when the window resets (ms epoch). */
  hit(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: number }>;
}

/** Who is calling; filled by the auth middleware on `/store` and `/admin`. */
export interface AuthState {
  key?: ApiKey;
  admin?: { userId: string; viaCookie: boolean };
  customer?: { userId: string };
}

export type AppEnv = {
  Variables: {
    requestId: string;
    log: Logger;
    auth: AuthState;
    /** Set by handlers via `recordChange`, read by the audit middleware. */
    /** Set when the handler already wrote its audit entry in its own transaction. */
    audited?: boolean;
    change?: { target: string; before?: unknown; after?: unknown };
  };
};

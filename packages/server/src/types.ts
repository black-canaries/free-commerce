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
  fingerprint: string;
  status: number;
  contentType: string;
  body: string;
}
export interface IdempotencyStore {
  get(key: string): Promise<StoredResponse | undefined>;
  set(key: string, value: StoredResponse): Promise<void>;
}

export interface RateLimitStore {
  /** Count a hit in the fixed window containing now; returns the count and when the window resets (ms epoch). */
  hit(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: number }>;
}

export type AppEnv = { Variables: { requestId: string; log: Logger } };

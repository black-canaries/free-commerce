/** @experimental Normalised failure from any external-service provider. */
export type ProviderErrorCode =
  | "not_found"
  | "rejected" // bad input or refused by the service; retrying won't help
  | "unavailable" // outage, timeout, rate limit; safe to retry
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: ProviderErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${provider}: ${message}`, options);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return this.code === "unavailable";
  }
}

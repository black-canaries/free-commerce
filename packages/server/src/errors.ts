import {
  ApiKeyError,
  CartError,
  CatalogError,
  DownloadError,
  PrivacyError,
  ProviderError,
  WebhookError,
} from "@free-commerce/core";
import type { ApiError, ErrorCode } from "@free-commerce/schema";
import { z } from "zod";

const STATUS = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_key_reuse: 422,
  rate_limited: 429,
  internal: 500,
} as const satisfies Record<ErrorCode, number>;

/** Throw from any handler or middleware; `onError` turns it into the wire `ApiError`. */
export class HttpError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly opts: {
      details?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

/** Parse `data` with `schema`, or throw `validation_failed` with Zod's per-field errors in `details`. */
export const parse = <S extends z.ZodType>(
  schema: S,
  data: unknown,
): z.output<S> => {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new HttpError("validation_failed", "Request validation failed", {
    details: z.flattenError(result.error),
  });
};

export const errorBody = (
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ApiError => ({ code, message, requestId, ...(details && { details }) });

const fromDownload = (err: DownloadError) => {
  if (err.code === "not_found")
    return new HttpError("not_found", "Download not found");
  if (err.code === "unavailable")
    return new HttpError("internal", "File temporarily unavailable");
  return new HttpError("forbidden", `Download ${err.code}`, {
    details: { reason: err.code },
  });
};

/** Domain errors thrown by core services become the matching `HttpError`; anything else is left alone. */
export const fromDomain = (err: unknown): HttpError | undefined => {
  if (err instanceof CatalogError)
    return new HttpError(err.code, err.message, {
      details: { issues: err.issues },
    });
  if (
    err instanceof CartError ||
    err instanceof ApiKeyError ||
    err instanceof WebhookError
  )
    return new HttpError(
      err.code === "not_found" ? "not_found" : "validation_failed",
      err.message,
    );
  if (err instanceof PrivacyError)
    return new HttpError("not_found", err.message);
  if (err instanceof DownloadError) return fromDownload(err);
  if (err instanceof ProviderError && err.code === "rejected")
    return new HttpError("validation_failed", err.message);
};

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

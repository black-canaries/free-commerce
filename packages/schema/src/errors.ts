import { z } from "zod";

export const ERROR_CODES = [
  "validation_failed",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_key_reuse",
  "rate_limited",
  "internal",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Wire shape of every API error. `message` is for developers; clients branch on `code`. */
export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

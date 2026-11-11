import { z } from "zod";

/** UTC ISO 8601 instant with a `Z` suffix, e.g. `2026-01-31T12:00:00.000Z`. */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

export const toTimestamp = (date: Date): Timestamp => date.toISOString();
export const now = (): Timestamp => toTimestamp(new Date());

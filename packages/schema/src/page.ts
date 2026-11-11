import { z } from "zod";

/** Cursor pagination request. Cursors are opaque to clients. */
export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** Cursor pagination response; `nextCursor` is null on the last page. */
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

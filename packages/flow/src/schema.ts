import { z } from "zod";

/** @experimental */
export const NodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["trigger", "condition", "action", "wait"]),
  /** Type-specific settings; interpreted by the runtime, not by this package. */
  config: z.record(z.string(), z.unknown()).default({}),
});

/** @experimental */
export const EdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** Branch label, e.g. "yes" / "no" out of a condition. */
  label: z.string().optional(),
});

/** @experimental */
export const GraphSchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

/** A flow holds a mutable draft and at most one frozen published version. @experimental */
export const FlowSchema = z.object({
  id: z.string().min(1),
  draft: GraphSchema,
  published: z
    .object({
      version: z.number().int().positive(),
      graph: GraphSchema,
      publishedAt: z.iso.datetime(),
    })
    .nullable(),
});

export type Node = z.infer<typeof NodeSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Graph = z.infer<typeof GraphSchema>;
export type Flow = z.infer<typeof FlowSchema>;

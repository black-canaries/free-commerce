import type { Flow, Graph } from "./schema";
import { type Issue, validateGraph } from "./validate";

/** Publishing freezes the draft as the next version; invalid drafts are rejected. @experimental */
export function publish(
  flow: Flow,
  now: Date,
): { flow: Flow } | { issues: Issue[] } {
  const issues = validateGraph(flow.draft);
  if (issues.length > 0) return { issues };
  const version = (flow.published?.version ?? 0) + 1;
  return {
    flow: {
      ...flow,
      published: {
        version,
        graph: structuredClone(flow.draft),
        publishedAt: now.toISOString(),
      },
    },
  };
}

/** Edits only ever touch the draft; the published graph is never mutated. @experimental */
export function editDraft(flow: Flow, draft: Graph): Flow {
  return { ...flow, draft };
}

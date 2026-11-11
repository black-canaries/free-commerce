import type { Graph } from "./schema";

export type Issue = {
  code:
    | "duplicate_node"
    | "no_trigger"
    | "multiple_triggers"
    | "dangling_edge"
    | "unreachable";
  nodeId?: string;
};

function reachable(starts: string[], edges: Graph["edges"]): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.from === id) stack.push(e.to);
  }
  return seen;
}

/** Returns all structural problems in a graph; empty means valid. @experimental */
export function validateGraph({ nodes, edges }: Graph): Issue[] {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const triggers = nodes.filter((n) => n.type === "trigger").map((n) => n.id);
  const issues: Issue[] = [];

  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i)
      issues.push({ code: "duplicate_node", nodeId: id });
  });
  if (triggers.length === 0) issues.push({ code: "no_trigger" });
  if (triggers.length > 1) issues.push({ code: "multiple_triggers" });
  for (const end of edges.flatMap((e) => [e.from, e.to])) {
    if (!known.has(end)) issues.push({ code: "dangling_edge", nodeId: end });
  }
  if (triggers.length > 0) {
    const seen = reachable(triggers, edges);
    for (const id of known)
      if (!seen.has(id)) issues.push({ code: "unreachable", nodeId: id });
  }
  return issues;
}

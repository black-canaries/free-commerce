import { describe, expect, it } from "vitest";
import { editDraft, type Graph, publish, validateGraph } from "./index";

const abandonedCart: Graph = {
  nodes: [
    { id: "t", type: "trigger", config: { event: "cart.abandoned" } },
    { id: "w", type: "wait", config: { minutes: 60 } },
    { id: "c", type: "condition", config: { if: "cart.recovered" } },
    { id: "a", type: "action", config: { kind: "email" } },
  ],
  edges: [
    { from: "t", to: "w" },
    { from: "w", to: "c" },
    { from: "c", to: "a", label: "no" },
  ],
};
const codes = (g: Graph) => validateGraph(g).map((i) => i.code);

describe("validateGraph", () => {
  it("accepts an abandoned-cart graph", () =>
    expect(validateGraph(abandonedCart)).toEqual([]));
  it("requires exactly one trigger", () => {
    const [t, ...rest] = abandonedCart.nodes;
    expect(codes({ ...abandonedCart, nodes: rest })).toContain("no_trigger");
    expect(
      codes({
        ...abandonedCart,
        nodes: [
          ...abandonedCart.nodes,
          { ...(t as Graph["nodes"][number]), id: "t2" },
        ],
      }),
    ).toContain("multiple_triggers");
  });
  it("rejects dangling edges and unreachable nodes", () => {
    expect(
      codes({
        ...abandonedCart,
        edges: [...abandonedCart.edges, { from: "a", to: "ghost" }],
      }),
    ).toContain("dangling_edge");
    expect(
      codes({ ...abandonedCart, edges: abandonedCart.edges.slice(0, 1) }),
    ).toEqual(["unreachable", "unreachable"]);
  });
  it("rejects duplicate node ids", () =>
    expect(
      codes({
        ...abandonedCart,
        nodes: [
          ...abandonedCart.nodes,
          abandonedCart.nodes[1] as Graph["nodes"][number],
        ],
      }),
    ).toContain("duplicate_node"));

  it("accepts linear chains of any length", () => {
    for (const n of [0, 1, 5, 50]) {
      const nodes: Graph["nodes"] = [{ id: "n0", type: "trigger", config: {} }];
      const edges: Graph["edges"] = [];
      for (let i = 1; i <= n; i++) {
        nodes.push({ id: `n${i}`, type: "action", config: {} });
        edges.push({ from: `n${i - 1}`, to: `n${i}` });
      }
      expect(validateGraph({ nodes, edges })).toEqual([]);
    }
  });
});

describe("versioning", () => {
  const flow = { id: "f", draft: abandonedCart, published: null };
  const at = new Date("2026-01-01T00:00:00Z");

  it("publishes a frozen copy and increments the version", () => {
    const first = publish(flow, at);
    if (!("flow" in first)) throw new Error("expected publish");
    const edited = editDraft(first.flow, {
      ...abandonedCart,
      nodes: abandonedCart.nodes.slice(0, 3),
      edges: abandonedCart.edges.slice(0, 2),
    });
    expect(edited.published?.graph).toEqual(abandonedCart);
    const second = publish(edited, at);
    expect("flow" in second && second.flow.published?.version).toBe(2);
  });
  it("rejects an invalid draft and keeps the old version", () => {
    const result = publish(editDraft(flow, { nodes: [], edges: [] }), at);
    expect(result).toEqual({ issues: [{ code: "no_trigger" }] });
  });
});

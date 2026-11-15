import { describe, expect, it } from "vitest";
import { adminGroup, can, newAuditEntry, summarize } from "./access";

describe("summarize", () => {
  it("masks sensitive keys, cuts long strings and bounds depth", () => {
    const out = summarize({
      role: "staff",
      email: "a@b.c",
      apiKey: "sk_x",
      note: "x".repeat(500),
      deep: { a: { b: { c: 1 } } },
    }) as Record<string, unknown>;
    expect(out.email).toBe("[redacted]");
    expect(out.apiKey).toBe("[redacted]");
    expect(out.role).toBe("staff");
    expect((out.note as string).length).toBeLessThan(100);
    expect(JSON.stringify(out.deep)).toContain("[truncated]");
  });

  it("entries carry only summaries", () => {
    const e = newAuditEntry(
      {
        actor: { type: "key", id: "k" },
        action: "A",
        target: "t",
        after: { password: "p" },
      },
      0,
    );
    expect(e.after).toEqual({ password: "[redacted]" });
    expect(e.before).toBeUndefined();
    expect(e.id).toMatch(/^aud_/);
  });
});

describe("permissions", () => {
  it("unknown roles, paths and prototype keys are denied", () => {
    expect(adminGroup("/admin/orders/1")).toBe("orders");
    expect(adminGroup("/admin/constructor")).toBeUndefined();
    expect(can("hacker" as never, "/admin/orders", "read")).toBe(false);
    expect(can(undefined, "/admin/orders", "read")).toBe(false);
    expect(can("staff", "/store/orders", "read")).toBe(false);
  });
});

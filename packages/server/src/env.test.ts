import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("applies defaults", () => {
    expect(
      loadEnv({ DATABASE_URL: "postgres://u:p@h/db" }).RATE_LIMIT_PER_MINUTE,
    ).toBe(120);
  });

  it("reports names, never values", () => {
    const run = () =>
      loadEnv({ DATABASE_URL: "", RATE_LIMIT_PER_MINUTE: "s3cret-nope" });
    expect(run).toThrow(/DATABASE_URL/);
    expect(run).not.toThrow(/s3cret-nope/);
  });
});

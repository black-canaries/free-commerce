import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiError,
  idSchema,
  newId,
  PageQuery,
  pageOf,
  Timestamp,
  toTimestamp,
} from "./index.js";

describe("newId", () => {
  it("is prefixed, valid and sorts by creation time", () => {
    const a = newId("prod", 1_000);
    const b = newId("prod", 2_000);
    expect(idSchema("prod").safeParse(a).success).toBe(true);
    expect(idSchema("ord").safeParse(a).success).toBe(false);
    expect(a < b).toBe(true);
    expect(newId("prod", 1_000)).not.toBe(a);
  });

  it("rejects bad timestamps", () => {
    for (const bad of [1.5, -1])
      expect(() => newId("prod", bad)).toThrow(RangeError);
  });

  it("rejects bad prefixes in newId and idSchema", () => {
    expect(() => newId("Prod")).toThrow(RangeError);
    expect(() => idSchema("a.*")).toThrow(RangeError);
  });
});

describe("Timestamp", () => {
  it("accepts UTC ISO 8601 only", () => {
    expect(Timestamp.safeParse(toTimestamp(new Date(0))).data).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(Timestamp.safeParse("2026-01-01T00:00:00+02:00").success).toBe(
      false,
    );
    expect(Timestamp.safeParse("2026-01-01T00:00:00Z").success).toBe(false);
  });
});

describe("page and error shapes", () => {
  it("defaults and bounds limit", () => {
    expect(PageQuery.parse({}).limit).toBe(20);
    expect(PageQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(PageQuery.parse({ limit: "50" }).limit).toBe(50);
    expect(PageQuery.safeParse({ cursor: "x".repeat(513) }).success).toBe(
      false,
    );
  });

  it("pageOf wraps items with nullable cursor", () => {
    expect(
      pageOf(z.string()).parse({ items: ["a"], nextCursor: null }),
    ).toEqual({ items: ["a"], nextCursor: null });
  });

  it("rejects unknown error codes", () => {
    expect(ApiError.safeParse({ code: "nope", message: "x" }).success).toBe(
      false,
    );
    expect(
      ApiError.safeParse({ code: "not_found", message: "x" }).success,
    ).toBe(true);
  });
});

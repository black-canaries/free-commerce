import { describe, expect, it } from "vitest";
import { ProviderError } from "./error";
import { storageConfigSchema } from "./storage";
import { storageConformance } from "./storage.conformance";
import { createFakeStorage } from "./storage.fake";

storageConformance("fake", () => createFakeStorage());

describe("fake storage", () => {
  it("signed URLs expire", async () => {
    let t = 0;
    const s = createFakeStorage(() => t);
    await s.put("k", new Uint8Array(), "text/plain");
    const url = await s.signedUrl("k", 10);
    expect(s.isValidUrl(url)).toBe(true);
    t = 10_000;
    expect(s.isValidUrl(url)).toBe(false);
  });
});

describe("storageConfigSchema", () => {
  it("requires a bucket", () => {
    expect(storageConfigSchema.safeParse({}).success).toBe(false);
    expect(storageConfigSchema.safeParse({ bucket: "b" }).success).toBe(true);
  });
});

describe("ProviderError", () => {
  it("is retryable only when unavailable", () => {
    expect(new ProviderError("p", "unavailable", "x").retryable).toBe(true);
    expect(new ProviderError("p", "rejected", "x").retryable).toBe(false);
  });
});

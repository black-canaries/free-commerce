import { describe, expect, it } from "vitest";
import { isSafeKey, newStorageKey, validateUpload } from "./upload";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
const opts = { maxBytes: 10, allowedTypes: ["image/png"] };

describe("validateUpload", () => {
  it("accepts a sniffed allowed type", () => {
    expect(validateUpload(png, opts)).toEqual({
      contentType: "image/png",
      ext: "png",
    });
  });
  it("rejects oversized and empty bodies", () => {
    expect(() => validateUpload(new Uint8Array(11), opts)).toThrow(/size/);
    expect(() => validateUpload(new Uint8Array(), opts)).toThrow(/size/);
  });
  it("accepts a body exactly at the size limit and rejects a non-finite limit", () => {
    const exact = new Uint8Array(10);
    exact.set(png);
    expect(validateUpload(exact, opts).ext).toBe("png");
    expect(() =>
      validateUpload(png, { ...opts, maxBytes: Number.NaN }),
    ).toThrow(/finite/);
    expect(() =>
      validateUpload(png, { ...opts, maxBytes: Number.POSITIVE_INFINITY }),
    ).toThrow(/finite/);
  });
  it("rejects a disallowed or unknown type", () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0]);
    expect(() => validateUpload(jpg, opts)).toThrow(/not allowed/);
    expect(() => validateUpload(new Uint8Array([1, 2, 3]), opts)).toThrow(
      /not allowed/,
    );
  });
  it("rejects a declared type that lies about the content", () => {
    expect(() =>
      validateUpload(png, { ...opts, declaredType: "application/pdf" }),
    ).toThrow(/declared/);
  });
  it("sniffs webp by its RIFF + WEBP markers", () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    const o = { maxBytes: 99, allowedTypes: ["image/webp"] };
    expect(validateUpload(webp, o).ext).toBe("webp");
    webp[8] = 0;
    expect(() => validateUpload(webp, o)).toThrow();
    webp[8] = 0x57;
    webp[0] = 0; // WEBP marker without RIFF
    expect(() => validateUpload(webp, o)).toThrow();
  });
});

describe("keys", () => {
  it.each(["a/b.bin", "k", "digital/x-1.zip"])("accepts %s", (k) => {
    expect(isSafeKey(k)).toBe(true);
  });
  it.each([
    "../x",
    "a/../b",
    "/abs",
    "a//b",
    ".hidden",
    "a\\b",
    "a/%2e%2e/b",
    "",
    "a/./b",
    "a\0b",
  ])("rejects %j", (k) => {
    expect(isSafeKey(k)).toBe(false);
  });
  it("generates safe keys and refuses a bad extension", () => {
    expect(isSafeKey(newStorageKey("media", "png"))).toBe(true);
    expect(() => newStorageKey("media", "../x")).toThrow();
    expect(() => newStorageKey("../m", "png")).toThrow();
  });
});

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "@free-commerce/core";
import { storageConformance } from "@free-commerce/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createLocalStorage } from "./local";

const SECRET = "s".repeat(32);
const BASE = "https://shop.test/files";
const roots: string[] = [];
const make = async (now = () => 1_000_000) => {
  const root = await mkdtemp(join(tmpdir(), "fc-local-"));
  roots.push(root);
  return {
    root,
    s: createLocalStorage({ root, baseUrl: BASE, secret: SECRET, now }),
  };
};
afterAll(() =>
  Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))),
);

// Conformance needs a sync factory; each call gets its own directory.
storageConformance("local-disk", () =>
  createLocalStorage({
    root: join(tmpdir(), `fc-conf-${crypto.randomUUID()}`),
    baseUrl: BASE,
    secret: SECRET,
  }),
);

const body = new Uint8Array([1, 2, 3]);
const withParam = (url: string, k: string, v: string) => {
  const u = new URL(url);
  u.searchParams.set(k, v);
  return u.toString();
};

describe("local signed URLs", () => {
  it("serves a valid URL", async () => {
    const { s } = await make();
    await s.put("p/a.bin", body, "text/plain");
    const got = await s.getSigned(await s.signedUrl("p/a.bin", 60));
    expect(got).toEqual({ body, contentType: "text/plain" });
  });

  it("rejects an expired URL", async () => {
    let t = 1_000_000;
    const { s } = await make(() => t);
    await s.put("a.bin", body, "text/plain");
    const url = await s.signedUrl("a.bin", 60);
    t += 60_000;
    expect(await s.getSigned(url)).toBeNull();
  });

  it("rejects an extended expiry", async () => {
    const { s } = await make();
    await s.put("a.bin", body, "text/plain");
    const url = await s.signedUrl("a.bin", 60);
    expect(
      await s.getSigned(withParam(url, "expires", "9999999999")),
    ).toBeNull();
  });

  it("rejects a swapped key", async () => {
    const { s } = await make();
    await s.put("a.bin", body, "text/plain");
    await s.put("b.bin", body, "text/plain");
    const url = await s.signedUrl("a.bin", 60);
    expect(await s.getSigned(url.replace("a.bin", "b.bin"))).toBeNull();
  });

  it("rejects a tampered or missing signature", async () => {
    const { s } = await make();
    await s.put("a.bin", body, "text/plain");
    const url = await s.signedUrl("a.bin", 60);
    expect(await s.getSigned(withParam(url, "sig", "0".repeat(64)))).toBeNull();
    expect(await s.getSigned(url.split("&sig=")[0] ?? "")).toBeNull();
  });

  it("rejects a URL signed with another secret", async () => {
    const { s, root } = await make();
    await s.put("a.bin", body, "text/plain");
    const other = createLocalStorage({
      root,
      baseUrl: BASE,
      secret: "x".repeat(32),
      now: () => 1_000_000,
    });
    expect(await s.getSigned(await other.signedUrl("a.bin", 60))).toBeNull();
  });

  it("rejects foreign origins and path traversal", async () => {
    const { s } = await make();
    await s.put("a.bin", body, "text/plain");
    const url = await s.signedUrl("a.bin", 60);
    expect(
      await s.getSigned(url.replace(BASE, "https://evil.test/files")),
    ).toBeNull();
    expect(await s.getSigned(url.replace("a.bin", "..%2Fa.bin"))).toBeNull();
    expect(await s.getSigned(url.replace("a.bin", "%2e%2e/a.bin"))).toBeNull();
    expect(await s.getSigned(url.replace("a.bin", "%E0%A4%A"))).toBeNull();
  });

  it("returns null once the object is deleted", async () => {
    const { s } = await make();
    await s.put("a.bin", body, "text/plain");
    const url = await s.signedUrl("a.bin", 60);
    await s.delete("a.bin");
    expect(await s.getSigned(url)).toBeNull();
  });

  it("rejects bad expiry values", async () => {
    const { s } = await make();
    await s.put("a.bin", body, "text/plain");
    for (const n of [0, -1, 1.5, 8 * 24 * 3600]) {
      await expect(s.signedUrl("a.bin", n)).rejects.toMatchObject({
        code: "rejected",
      });
    }
  });
});

describe("local keys and privacy", () => {
  it("rejects unsafe keys on every method and writes nothing", async () => {
    const { s, root } = await make();
    for (const k of ["../escape", "/abs", "a/../../x", ".hidden"]) {
      for (const call of [
        () => s.put(k, body, "text/plain"),
        () => s.get(k),
        () => s.delete(k),
        () => s.signedUrl(k, 60),
      ]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).code).toBe("rejected");
      }
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a short secret", () => {
    expect(() =>
      createLocalStorage({ root: "/x", baseUrl: BASE, secret: "short" }),
    ).toThrow(ProviderError);
  });

  it("surfaces unexpected fs errors as ProviderError unknown without leaking the secret", async () => {
    const { s, root } = await make();
    await s.put("a", body, "text/plain");
    const err = await s.put("a/b", body, "text/plain").catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("unknown");
    expect(String(err)).not.toContain(SECRET);
    expect(root).toBeTruthy();
  });
});

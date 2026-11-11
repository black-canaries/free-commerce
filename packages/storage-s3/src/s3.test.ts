import { ProviderError } from "@free-commerce/core";
import { storageConformance } from "@free-commerce/core/testing";
import { describe, expect, it } from "vitest";
import { createS3Storage } from "./s3";

function failure(f?: number | Error): Response | undefined {
  if (f instanceof Error) throw f;
  return f ? new Response(null, { status: f }) : undefined;
}

/** Minimal in-memory S3: path-style PUT/GET/HEAD/DELETE. Records every request. */
function fakeS3(failWith?: number | Error) {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const requests: Request[] = [];
  const fetch = async (req: Request): Promise<Response> => {
    requests.push(req);
    const failed = failure(failWith);
    if (failed) return failed;
    const path = new URL(req.url).pathname;
    const o = objects.get(path);
    switch (req.method) {
      case "PUT":
        objects.set(path, {
          body: new Uint8Array(await req.arrayBuffer()),
          type: req.headers.get("content-type") ?? "",
        });
        return new Response(null, { status: 200 });
      case "DELETE":
        objects.delete(path);
        return new Response(null, { status: 204 });
      default:
        if (!o) return new Response(null, { status: 404 });
        return new Response(
          req.method === "HEAD" ? null : (o.body as BodyInit),
          {
            headers: { "content-type": o.type },
          },
        );
    }
  };
  return { fetch, requests, objects };
}

const make = (fetch: (r: Request) => Promise<Response>) =>
  createS3Storage({
    bucket: "bkt",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    fetch,
  });

storageConformance("s3 (fake fetch)", () => make(fakeS3().fetch));

describe("s3 signing", () => {
  it("requests are SigV4-signed and never send the secret", async () => {
    const f = fakeS3();
    await make(f.fetch).put("a/b.bin", new Uint8Array([1]), "text/plain");
    const req = f.requests[0];
    expect(req?.url).toBe("https://s3.us-east-1.amazonaws.com/bkt/a/b.bin");
    expect(req?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\//,
    );
    expect(JSON.stringify([...(req?.headers ?? [])])).not.toContain("SECRET");
  });

  it("presigns a short-lived GET URL with signature in the query", async () => {
    const f = fakeS3();
    const s = make(f.fetch);
    await s.put("a.bin", new Uint8Array([1]), "text/plain");
    const u = new URL(await s.signedUrl("a.bin", 90));
    expect(u.searchParams.get("X-Amz-Expires")).toBe("90");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(u.toString()).not.toContain("SECRET");
  });

  it("presigns differently per key and per expiry", async () => {
    const s = make(fakeS3().fetch);
    for (const k of ["a.bin", "b.bin"])
      await s.put(k, new Uint8Array([1]), "text/plain");
    const sig = async (k: string, n: number) =>
      new URL(await s.signedUrl(k, n)).searchParams.get("X-Amz-Signature");
    expect(
      new Set([
        await sig("a.bin", 60),
        await sig("b.bin", 60),
        await sig("a.bin", 61),
      ]).size,
    ).toBe(3);
  });

  it("rejects bad expiry and unsafe keys without any request", async () => {
    const f = fakeS3();
    const s = make(f.fetch);
    for (const n of [0, 1.5, 8 * 24 * 3600]) {
      await expect(s.signedUrl("a.bin", n)).rejects.toMatchObject({
        code: "rejected",
      });
    }
    for (const k of ["../x", "/abs", "a/../b"]) {
      await expect(
        s.put(k, new Uint8Array(), "text/plain"),
      ).rejects.toMatchObject({ code: "rejected" });
      await expect(s.signedUrl(k, 60)).rejects.toMatchObject({
        code: "rejected",
      });
    }
    expect(f.requests).toHaveLength(0);
  });
});

describe("s3 failure mapping", () => {
  const body = new Uint8Array([1]);
  it.each([
    [500, "unavailable"],
    [503, "unavailable"],
    [429, "unavailable"],
    [403, "rejected"],
  ])("HTTP %i -> %s", async (status, code) => {
    const s = make(fakeS3(status).fetch);
    for (const call of [
      () => s.put("k", body, "text/plain"),
      () => s.get("k"),
      () => s.delete("k"),
      () => s.signedUrl("k", 60),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe(code);
    }
  });

  it("network errors are unavailable and retryable", async () => {
    const err = await make(fakeS3(new TypeError("boom")).fetch)
      .get("k")
      .catch((e: unknown) => e);
    expect((err as ProviderError).retryable).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { ProviderError } from "./error";
import type { StorageProvider } from "./storage";

/** @experimental Every `StorageProvider` adapter (fake or real) must pass this. */
export function storageConformance(
  name: string,
  make: () => StorageProvider,
): void {
  describe(`StorageProvider conformance: ${name}`, () => {
    const bytes = new Uint8Array([1, 2, 3]);

    it("round-trips body and content type", async () => {
      const s = make();
      await s.put("a/b.bin", bytes, "application/octet-stream");
      expect(await s.get("a/b.bin")).toEqual({
        body: bytes,
        contentType: "application/octet-stream",
      });
    });

    it("get on a missing key resolves null", async () => {
      expect(await make().get("missing")).toBeNull();
    });

    it("put overwrites", async () => {
      const s = make();
      await s.put("k", bytes, "text/plain");
      await s.put("k", new Uint8Array([9]), "text/plain");
      expect((await s.get("k"))?.body).toEqual(new Uint8Array([9]));
    });

    it("delete is idempotent", async () => {
      const s = make();
      await s.put("k", bytes, "text/plain");
      await s.delete("k");
      await s.delete("k");
      expect(await s.get("k")).toBeNull();
    });

    it("signedUrl returns a url for an existing key", async () => {
      const s = make();
      await s.put("k", bytes, "text/plain");
      expect(await s.signedUrl("k", 60)).toEqual(expect.any(String));
    });

    it("signedUrl for a missing key rejects with ProviderError not_found", async () => {
      const err = await make()
        .signedUrl("missing", 60)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("not_found");
    });
  });
}

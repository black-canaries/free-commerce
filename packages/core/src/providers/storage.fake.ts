import { ProviderError } from "./error";
import type { StorageProvider } from "./storage";

/** @experimental In-memory `StorageProvider` for tests. Signed URLs expire against `now`. */
export function createFakeStorage(
  now: () => number = Date.now,
): StorageProvider & {
  /** Whether a URL from `signedUrl` is still valid. */
  isValidUrl(url: string): boolean;
} {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const urls = new Map<string, number>();
  return {
    async put(key, body, contentType) {
      objects.set(key, { body: body.slice(), contentType });
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { body: o.body.slice(), contentType: o.contentType } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async signedUrl(key, expiresInSeconds) {
      if (!objects.has(key))
        throw new ProviderError("fake-storage", "not_found", key);
      const url = `fake://${key}?sig=${urls.size}`;
      urls.set(url, now() + expiresInSeconds * 1000);
      return url;
    },
    isValidUrl: (url) => (urls.get(url) ?? 0) > now(),
  };
}

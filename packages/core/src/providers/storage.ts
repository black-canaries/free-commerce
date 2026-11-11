import { z } from "zod";

/** @experimental Config for a real storage adapter; secrets come from env, never code. */
export const storageConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1).optional(),
  endpoint: z.url().optional(),
});
export type StorageConfig = z.infer<typeof storageConfigSchema>;

/**
 * @experimental Object storage. Adapters map vendor errors to `ProviderError`
 * (a missing key is `not_found` where documented, never a vendor-specific error).
 */
export interface StorageProvider {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Resolves `null` when the key does not exist. */
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Short-lived read URL; throws `ProviderError("not_found")` if the key is missing. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

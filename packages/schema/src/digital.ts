import { z } from "zod";
import { DigitalAssetId } from "./catalog.js";
import { idSchema } from "./id.js";
import { Timestamp } from "./time.js";

export const DownloadGrantId = idSchema("grant");

/**
 * A file sold as a digital variant. `storageKey` is private and never leaves the server: customers only ever
 * receive short-lived signed URLs. Replacing the file updates this row in place, so existing grants keep working.
 */
export const DigitalAsset = z.strictObject({
  id: DigitalAssetId,
  /** Shown to the customer as the download's name. */
  filename: z.string().trim().min(1).max(200),
  storageKey: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().positive(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type DigitalAsset = z.infer<typeof DigitalAsset>;

const count = z.number().int().nonnegative();

/**
 * The right to download one asset from one order line. `maxDownloads` and `expiresAt` null mean unlimited. Only
 * the SHA-256 of the guest link token is stored (`accessHash`, shared by all grants of an order).
 */
export const DownloadGrant = z.strictObject({
  id: DownloadGrantId,
  orderId: idSchema("ord"),
  lineId: idSchema("line"),
  assetId: DigitalAssetId,
  maxDownloads: z.number().int().positive().nullable(),
  downloads: count,
  expiresAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  accessHash: z.string().nullable(),
  createdAt: Timestamp,
});
export type DownloadGrant = z.infer<typeof DownloadGrant>;

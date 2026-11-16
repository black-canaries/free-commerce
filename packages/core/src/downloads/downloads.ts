import {
  DigitalAsset,
  type DownloadGrant,
  newId,
  type Order,
  toTimestamp,
  type Variant,
} from "@free-commerce/schema";
import { hashSecret, hex } from "../auth/apikeys";
import type { StorageProvider } from "../providers/storage";
import type { ConsumeResult, Database, Repositories } from "../repositories";

/** @experimental `not_found` also answers a grant the caller may not see: ids and tokens reveal nothing. */
export class DownloadError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "revoked"
      | "expired"
      | "exhausted"
      | "unavailable",
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DownloadError";
  }
}

/** @experimental Store-wide defaults applied when a grant is created; `null` is unlimited. */
export interface DownloadSettings {
  lifetimeDays: number | null;
  maxDownloads: number | null;
}

/** @experimental What a customer sees of a grant; never the storage key. */
export interface DownloadView {
  id: string;
  orderId: string;
  filename: string;
  size: number;
  expiresAt: string | null;
  downloadsLeft: number | null;
}

/** @experimental Proof of access: the customer's own order ids (from their session) or a guest link token. */
export type DownloadAccess =
  | { orderIds: readonly string[] }
  | { token: string };

/** The rule behind `DownloadGrantRepository.consume`, shared by every adapter; a pure decision on one grant. */
export const decideConsume = (
  grant: DownloadGrant | null | undefined,
  now: string,
): ConsumeResult => {
  if (!grant) return { ok: false, reason: "not_found" };
  if (grant.revokedAt) return { ok: false, reason: "revoked" };
  if (grant.expiresAt !== null && grant.expiresAt <= now)
    return { ok: false, reason: "expired" };
  if (grant.maxDownloads !== null && grant.downloads >= grant.maxDownloads)
    return { ok: false, reason: "exhausted" };
  return { ok: true, grant: { ...grant, downloads: grant.downloads + 1 } };
};

const DAY_MS = 86_400_000;
/** Signed URLs live just long enough to start the transfer; the grant, not the URL, is the entitlement. */
const URL_SECONDS = 60;

/** @experimental */
export interface DownloadDeps {
  db: Database;
  storage: StorageProvider;
  variantOf(variantId: string): Promise<Variant | null>;
  settings?: DownloadSettings;
  now?: () => Date;
}

/**
 * @experimental Digital delivery (ADR 0031). Files are reachable only through a grant: `url` checks the
 * caller's proof, consumes one download atomically, and returns a signed URL that expires in a minute.
 */
export function createDownloads(d: DownloadDeps) {
  const now = d.now ?? (() => new Date());
  const settings = d.settings ?? { lifetimeDays: 30, maxDownloads: 5 };

  /** The grants the proof opens; empty for a wrong token or foreign orders. */
  async function allowed(access: DownloadAccess): Promise<DownloadGrant[]> {
    if ("token" in access)
      return d.db.grants.find("accessHash", await hashSecret(access.token));
    const lists = await Promise.all(
      access.orderIds.map((id) => d.db.grants.find("orderId", id)),
    );
    return lists.flat();
  }

  /** The asset a digital order line delivers, if its variant (still) has one. */
  const assetOf = async (line: Order["lines"][number]) =>
    line.deliveryType === "digital" && line.variantId
      ? (await d.variantOf(line.variantId))?.digitalAssetId
      : undefined;

  return {
    /** Inside the order transaction: one grant per digital line whose variant has an asset. Idempotent. */
    async grant(tx: Repositories, order: Order): Promise<void> {
      const at = now();
      for (const line of order.lines) {
        const assetId = await assetOf(line);
        const id = `grant_${line.id.slice(5)}`;
        if (!assetId || (await tx.grants.get(id))) continue;
        await tx.grants.save({
          id,
          orderId: order.id,
          lineId: line.id,
          assetId,
          maxDownloads: settings.maxDownloads,
          downloads: 0,
          expiresAt:
            settings.lifetimeDays === null
              ? null
              : toTimestamp(
                  new Date(at.getTime() + settings.lifetimeDays * DAY_MS),
                ),
          revokedAt: null,
          accessHash: null,
          createdAt: toTimestamp(at),
        });
      }
    },

    /** Inside the refund/cancel transaction. Idempotent; the grants stay for the record. */
    async revoke(tx: Repositories, order: Order): Promise<void> {
      const stamp = toTimestamp(now());
      for (const g of await tx.grants.find("orderId", order.id))
        if (!g.revokedAt) await tx.grants.save({ ...g, revokedAt: stamp });
    },

    /**
     * A new guest link token for the order, or null if it has no grants. Only its hash is stored; the token
     * is returned once, for the delivery email. Issuing again replaces it, so older links stop working.
     */
    async issueLink(orderId: string): Promise<string | null> {
      const token = `dl_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
      const accessHash = await hashSecret(token);
      return d.db.transaction(async (tx) => {
        const grants = await tx.grants.find("orderId", orderId);
        for (const g of grants) await tx.grants.save({ ...g, accessHash });
        return grants.length > 0 ? token : null;
      });
    },

    /** The downloads the proof opens, with their remaining allowance. Spent and revoked grants are listed too. */
    async list(access: DownloadAccess): Promise<DownloadView[]> {
      const grants = await allowed(access);
      return Promise.all(
        grants
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map(async (g) => {
            const asset = await d.db.assets.get(g.assetId);
            return {
              id: g.id,
              orderId: g.orderId,
              filename: asset?.filename ?? "",
              size: asset?.size ?? 0,
              expiresAt: g.expiresAt,
              downloadsLeft:
                g.maxDownloads === null
                  ? null
                  : Math.max(0, g.maxDownloads - g.downloads),
            };
          }),
      );
    },

    /**
     * A signed URL for one grant, counting one download. A grant the proof does not open is `not_found`,
     * indistinguishable from one that does not exist. The URL is signed before the count is taken, so a
     * storage failure never burns a download.
     */
    async url(access: DownloadAccess, grantId: string) {
      const grant = (await allowed(access)).find((g) => g.id === grantId);
      if (!grant) throw new DownloadError("not_found");
      const early = decideConsume(grant, toTimestamp(now()));
      if (!early.ok) throw new DownloadError(early.reason);
      const asset = await d.db.assets.get(grant.assetId);
      if (!asset) throw new DownloadError("unavailable", "asset missing");
      const url = await d.storage
        .signedUrl(asset.storageKey, URL_SECONDS, { filename: asset.filename })
        .catch((e: unknown) => {
          throw new DownloadError("unavailable", String(e));
        });
      const used = await d.db.grants.consume(grant.id, toTimestamp(now()));
      if (!used.ok) throw new DownloadError(used.reason);
      return { url, expiresInSeconds: URL_SECONDS };
    },

    /** Admin: register an uploaded file. */
    async createAsset(
      file: Pick<
        DigitalAsset,
        "filename" | "storageKey" | "contentType" | "size"
      >,
    ): Promise<DigitalAsset> {
      const at = toTimestamp(now());
      const asset = DigitalAsset.parse({
        ...file,
        id: newId("asset", now().getTime()),
        createdAt: at,
        updatedAt: at,
      });
      await d.db.assets.save(asset);
      return asset;
    },

    /**
     * Admin: point an asset at a new file. Grants reference the asset, so they stay valid and later downloads
     * get the new file. The old object is deleted after the switch; failing to delete it only leaks storage.
     */
    async replaceAsset(
      id: string,
      file: Pick<
        DigitalAsset,
        "filename" | "storageKey" | "contentType" | "size"
      >,
    ): Promise<DigitalAsset | null> {
      const old = await d.db.assets.get(id);
      if (!old) return null;
      const next = DigitalAsset.parse({
        ...old,
        ...file,
        updatedAt: toTimestamp(now()),
      });
      await d.db.assets.save(next);
      if (old.storageKey !== next.storageKey)
        await d.storage.delete(old.storageKey).catch(() => undefined);
      return next;
    },
  };
}

/** @experimental */
export type Downloads = ReturnType<typeof createDownloads>;

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isSafeKey,
  ProviderError,
  type StorageProvider,
} from "@free-commerce/core";

const MAX_TTL_SECONDS = 24 * 3600;
const NAME = "local-storage";

export interface LocalStorageOptions {
  /** Directory holding all objects. Keep it outside any web-served path. */
  root: string;
  /** Public origin + path of the route that serves signed URLs, e.g. `https://shop.example/files`. */
  baseUrl: string;
  /** HMAC key, at least 32 chars, from env. Never logged. */
  secret: string;
  now?: () => number;
}

export interface LocalStorage extends StorageProvider {
  /**
   * For the serving route: resolves the object a signed URL grants, or `null` if the URL is
   * foreign, tampered (key or expiry changed), expired, malformed or the object is gone.
   */
  getSigned(
    url: string,
  ): Promise<{ body: Uint8Array; contentType: string } | null>;
}

/** @experimental Node-only. Objects are private: reachable only through `getSigned` with a valid URL. */
export function createLocalStorage(opts: LocalStorageOptions): LocalStorage {
  if (opts.secret.length < 32)
    throw new ProviderError(
      NAME,
      "rejected",
      "secret must be at least 32 characters",
    );
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const data = (key: string) => join(opts.root, "data", key);
  const type = (key: string) => join(opts.root, "type", key);
  const sign = (key: string, expires: number) =>
    createHmac("sha256", opts.secret).update(`${key}\n${expires}`).digest();
  const parse = (raw: string) => parseSigned(raw, base, now(), sign);
  const checkKey = (key: string) => {
    if (!isSafeKey(key))
      throw new ProviderError(NAME, "rejected", "invalid key");
  };

  const get: LocalStorage["get"] = async (key) => {
    checkKey(key);
    try {
      const [body, contentType] = await Promise.all([
        readFile(data(key)),
        readFile(type(key), "utf8"),
      ]);
      return { body: new Uint8Array(body), contentType };
    } catch (e) {
      return missingOr(e, null);
    }
  };

  return {
    get,
    async put(key, body, contentType) {
      checkKey(key);
      try {
        // Type first, data last: an object exists only once its data is renamed into place.
        for (const [path, content] of [
          [type(key), contentType],
          [data(key), body],
        ] as const) {
          await mkdir(dirname(path), { recursive: true });
          const tmp = `${path}.${crypto.randomUUID()}.tmp`;
          await writeFile(tmp, content);
          await rename(tmp, path);
        }
      } catch (e) {
        throw new ProviderError(NAME, "unknown", "write failed", { cause: e });
      }
    },
    async delete(key) {
      checkKey(key);
      await Promise.all(
        [data(key), type(key)].map((p) => rm(p, { force: true })),
      );
    },
    async signedUrl(key, expiresInSeconds) {
      checkKey(key);
      if (
        !Number.isInteger(expiresInSeconds) ||
        expiresInSeconds < 1 ||
        expiresInSeconds > MAX_TTL_SECONDS
      )
        throw new ProviderError(NAME, "rejected", "invalid expiry");
      const exists = await stat(data(key)).then(
        (s) => s.isFile(),
        (e: unknown) => missingOr(e, false),
      );
      if (!exists) throw new ProviderError(NAME, "not_found", key);
      const expires = Math.floor(now() / 1000) + expiresInSeconds;
      return `${base}/${key.split("/").map(encodeURIComponent).join("/")}?expires=${expires}&sig=${sign(key, expires).toString("hex")}`;
    },
    async getSigned(raw) {
      const key = parse(raw);
      return key ? get(key) : null;
    },
  };
}

function missingOr<T>(e: unknown, fallback: T): T {
  // Key is a directory (EISDIR), a prefix of a file (ENOTDIR) or too long: no such object.
  const code = (e as NodeJS.ErrnoException).code ?? "";
  if (["ENOENT", "ENOTDIR", "EISDIR", "ENAMETOOLONG"].includes(code))
    return fallback;
  throw new ProviderError(NAME, "unknown", "filesystem error", { cause: e });
}

/** Returns the key only for an in-date, untampered URL minted for `base`; otherwise `null`. */
function parseSigned(
  raw: string,
  base: string,
  nowMs: number,
  sign: (key: string, expires: number) => Buffer,
): string | null {
  if (!raw.startsWith(`${base}/`)) return null;
  const [path = "", query = ""] =
    raw
      .slice(base.length + 1)
      .split("#")[0]
      ?.split("?") ?? [];
  const params = new URLSearchParams(query);
  const expires = params.get("expires") ?? "";
  const sig = params.get("sig") ?? "";
  let key: string;
  try {
    key = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (
    !isSafeKey(key) ||
    !/^[1-9]\d{0,14}$/.test(expires) ||
    !/^[0-9a-f]{64}$/.test(sig)
  )
    return null;
  if (Number(expires) * 1000 <= nowMs) return null;
  return timingSafeEqual(Buffer.from(sig, "hex"), sign(key, Number(expires)))
    ? key
    : null;
}

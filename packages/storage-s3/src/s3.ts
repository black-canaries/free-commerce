import {
  isSafeKey,
  ProviderError,
  type StorageConfig,
  type StorageProvider,
} from "@free-commerce/core";
import { AwsClient } from "aws4fetch";

const MAX_TTL_SECONDS = 7 * 24 * 3600; // SigV4 presign limit
const NAME = "s3-storage";

export interface S3StorageOptions extends StorageConfig {
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetch?: (req: Request) => Promise<Response>;
}

/**
 * @experimental S3/R2/MinIO via SigV4 (`aws4fetch`; fetch-only, edge-safe). Path-style URLs.
 * Objects are private: the only read access is a presigned, short-lived URL.
 * `endpoint` defaults to AWS; for R2 use `https://<account>.r2.cloudflarestorage.com` and region `auto`.
 */
export function createS3Storage(opts: S3StorageOptions): StorageProvider {
  const region = opts.region ?? "us-east-1";
  const origin = (
    opts.endpoint ?? `https://s3.${region}.amazonaws.com`
  ).replace(/\/+$/, "");
  const client = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    service: "s3",
    region,
  });
  const send = opts.fetch ?? fetch;
  const urlOf = (key: string) => {
    if (!isSafeKey(key))
      throw new ProviderError(NAME, "rejected", "invalid key");
    return `${origin}/${opts.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  };
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await send(await client.sign(url, init));
    } catch (e) {
      throw new ProviderError(NAME, "unavailable", "request failed", {
        cause: e,
      });
    }
    return res;
  };
  const fail = (res: Response): never => {
    const code =
      res.status >= 500 || res.status === 429 ? "unavailable" : "rejected";
    throw new ProviderError(NAME, code, `HTTP ${res.status}`);
  };

  return {
    async put(key, body, contentType) {
      const res = await call(urlOf(key), {
        method: "PUT",
        body: body as BodyInit,
        headers: { "content-type": contentType },
      });
      if (!res.ok) fail(res);
    },
    async get(key) {
      const res = await call(urlOf(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) fail(res);
      return {
        body: new Uint8Array(await res.arrayBuffer()),
        contentType:
          res.headers.get("content-type") ?? "application/octet-stream",
      };
    },
    async delete(key) {
      const res = await call(urlOf(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) fail(res);
    },
    async signedUrl(key, expiresInSeconds) {
      const url = urlOf(key);
      if (
        !Number.isInteger(expiresInSeconds) ||
        expiresInSeconds < 1 ||
        expiresInSeconds > MAX_TTL_SECONDS
      )
        throw new ProviderError(NAME, "rejected", "invalid expiry");
      const head = await call(url, { method: "HEAD" });
      if (head.status === 404) throw new ProviderError(NAME, "not_found", key);
      if (!head.ok) fail(head);
      const signed = await client.sign(
        `${url}?X-Amz-Expires=${expiresInSeconds}`,
        {
          method: "GET",
          aws: { signQuery: true },
        },
      );
      return signed.url;
    },
  };
}

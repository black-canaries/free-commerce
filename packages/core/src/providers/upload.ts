import { ProviderError } from "./error";

const SIGNATURES: readonly {
  type: string;
  ext: string;
  test: (b: Uint8Array) => boolean;
}[] = [
  {
    type: "image/png",
    ext: "png",
    test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  },
  {
    type: "image/jpeg",
    ext: "jpg",
    test: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    type: "image/gif",
    ext: "gif",
    test: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
  },
  {
    type: "image/webp",
    ext: "webp",
    test: (b) =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
      at(b, 8, [0x57, 0x45, 0x42, 0x50]),
  },
  {
    type: "application/pdf",
    ext: "pdf",
    test: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]),
  },
  {
    type: "application/zip",
    ext: "zip",
    test: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  },
];

const at = (b: Uint8Array, off: number, sig: number[]) =>
  sig.every((v, i) => b[off + i] === v);
const startsWith = (b: Uint8Array, sig: number[]) => at(b, 0, sig);

/**
 * @experimental Validates an upload before it reaches a `StorageProvider`: size, and the
 * type sniffed from magic bytes (the client-declared type is only cross-checked, never trusted).
 * Throws `ProviderError("rejected")`. Returns the sniffed type and a file extension.
 */
export function validateUpload(
  body: Uint8Array,
  opts: {
    maxBytes: number;
    allowedTypes: readonly string[];
    declaredType?: string;
  },
): { contentType: string; ext: string } {
  if (body.byteLength === 0 || body.byteLength > opts.maxBytes)
    throw new ProviderError("upload", "rejected", "size out of bounds");
  const sniffed = SIGNATURES.find((s) => s.test(body));
  if (!sniffed || !opts.allowedTypes.includes(sniffed.type))
    throw new ProviderError("upload", "rejected", "file type not allowed");
  if (opts.declaredType && opts.declaredType !== sniffed.type)
    throw new ProviderError(
      "upload",
      "rejected",
      "declared type does not match content",
    );
  return { contentType: sniffed.type, ext: sniffed.ext };
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** @experimental Storage keys are generated, never user paths: no leading dot or `..` segments, no `\`, no empty segments. */
export function isSafeKey(key: string): boolean {
  return key.length <= 512 && SAFE_KEY.test(key) && !key.includes("..");
}

/** @experimental Generated key `<prefix>/<uuid>.<ext>`; `prefix` must itself be a safe key. */
export function newStorageKey(prefix: string, ext: string): string {
  const key = `${prefix}/${crypto.randomUUID()}.${ext}`;
  if (!isSafeKey(key) || !/^[a-z0-9]+$/.test(ext))
    throw new ProviderError("upload", "rejected", "unsafe key");
  return key;
}

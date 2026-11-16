import {
  API_SCOPES,
  type ApiKey,
  archiveProduct,
  createApiKey,
  createInventory,
  createProduct,
  fulfil,
  isSafeKey,
  newAuditEntry,
  newStorageKey,
  type OrderResult,
  type ProductInput,
  publishProduct,
  revokeApiKey,
  rotateApiKey,
  toSearchDoc,
  transitionLifecycle,
  updateProduct,
  validateUpload,
} from "@free-commerce/core";
import {
  type DigitalAsset,
  Order,
  PageQuery,
  Product,
  ProductId,
  ProductOption,
  VariantId,
} from "@free-commerce/schema";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { actorOf } from "./access.js";
import type { AppDeps } from "./app.js";
import { HttpError, parse } from "./errors.js";
import type { AppEnv } from "./types.js";

const json = (c: Context<AppEnv>) => c.req.json().catch(() => undefined);

/** Variants are validated by core against the `Variant` schema, which reports every field. */
const ProductBody = z.strictObject({
  title: z.string(),
  handle: z.string(),
  description: z.string().optional(),
  options: z.array(ProductOption).optional(),
  variants: z.array(z.record(z.string(), z.unknown())).min(1),
});

const NewKey = z.strictObject({
  type: z.enum(["publishable", "secret"]),
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  expiresAt: z.iso.datetime().optional(),
});

/** Never includes the hash. */
const keyView = ({ hash: _hash, ...key }: ApiKey) => key;

/** Becomes the customer's file name and a response header: no path separators, quotes or control characters. */
const AssetName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (n) =>
      !(
        /[/"]/.test(n) ||
        [...n].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      ),
    "invalid filename",
  );

const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ASSETS = [...IMAGES, "application/pdf", "application/zip"];

export const mountAdminRoutes = (app: Hono<AppEnv>, d: AppDeps): void => {
  const admin = app.basePath("/admin");
  const now = d.now ?? Date.now;
  const clock = () => new Date(now());
  const inventory = createInventory(d.db.inventory, clock);
  const change = (c: Context<AppEnv>, target: string, after?: unknown) =>
    c.set("change", { target, after });

  /** Search is eventually consistent with the catalog (ADR 0025): every product change re-indexes. */
  const reindex = async (product: Product) => {
    const stock = await Promise.all(
      product.variants.map(async (v) =>
        v.manageInventory && !v.allowBackorder
          ? (await inventory.available(v.id)) > 0
          : true,
      ),
    );
    const doc = toSearchDoc(product, [], stock.includes(true));
    await (doc ? d.search.index(doc) : d.search.remove(product.id));
  };
  const product = async (id: string) => {
    const found = await d.db.products.get(parse(ProductId, id));
    if (!found) throw new HttpError("not_found", "Product not found");
    return Product.parse(found);
  };
  const saveProduct = async (c: Context<AppEnv>, p: Product, status = 200) => {
    await d.db.products.save(p);
    await reindex(p);
    change(c, `products/${p.id}`, { status: p.status });
    return c.json(p, status as 200);
  };

  admin.get("/products", async (c) =>
    c.json(await d.db.products.list(parse(PageQuery, c.req.query()))),
  );
  admin.get("/products/:id", async (c) =>
    c.json(await product(c.req.param("id"))),
  );
  admin.post("/products", async (c) =>
    saveProduct(
      c,
      createProduct(parse(ProductBody, await json(c)) as ProductInput, clock()),
      201,
    ),
  );
  admin.patch("/products/:id", async (c) =>
    saveProduct(
      c,
      updateProduct(
        await product(c.req.param("id")),
        parse(ProductBody.partial(), await json(c)) as Partial<ProductInput>,
        clock(),
      ),
    ),
  );
  admin.post("/products/:id/publish", async (c) =>
    saveProduct(c, publishProduct(await product(c.req.param("id")), clock())),
  );
  admin.post("/products/:id/archive", async (c) =>
    saveProduct(c, archiveProduct(await product(c.req.param("id")), clock())),
  );

  // Stock is per variant; the product id is required so the search index can be refreshed.
  admin.get("/inventory/:variantId", async (c) => {
    const id = parse(VariantId, c.req.param("variantId"));
    return c.json({
      variantId: id,
      onHand: (await d.db.inventory.getStock(id))?.quantity ?? 0,
      available: await inventory.available(id),
    });
  });
  admin.put("/inventory/:variantId", async (c) => {
    const id = parse(VariantId, c.req.param("variantId"));
    const body = parse(
      z.strictObject({ productId: ProductId, quantity: z.number().int() }),
      await json(c),
    );
    const p = await product(body.productId);
    if (!p.variants.some((v) => v.id === id))
      throw new HttpError("not_found", "Variant not found");
    await inventory.setStock(id, body.quantity);
    await reindex(p);
    change(c, `inventory/${id}`, { quantity: body.quantity });
    return c.json({ variantId: id, onHand: body.quantity });
  });

  const order = async (tx: Pick<AppDeps["db"], "orders">, id: string) => {
    const found = await tx.orders.get(id);
    if (!found) throw new HttpError("not_found", "Order not found");
    return Order.parse(found);
  };
  const orderAction = (c: Context<AppEnv>, run: (o: Order) => OrderResult) =>
    d.db.transaction(async (tx) => {
      const id = c.req.param("id") ?? "";
      const result = run(await order(tx, id));
      if (!result.ok)
        throw new HttpError("conflict", "Order transition refused", {
          details: result.error,
        });
      await tx.orders.save(result.order);
      change(c, `orders/${id}`, {
        status: result.order.status,
        fulfilment: result.order.fulfilmentStatus,
      });
      return c.json(result.order);
    });
  admin.get("/orders", async (c) =>
    c.json(await d.db.orders.list(parse(PageQuery, c.req.query()))),
  );
  admin.get("/orders/:id", async (c) =>
    c.json(await order(d.db, c.req.param("id"))),
  );
  admin.post("/orders/:id/fulfil", async (c) => {
    const { items } = parse(
      z.strictObject({
        items: z
          .array(
            z.strictObject({
              lineId: z.string(),
              quantity: z.number().int().positive(),
            }),
          )
          .min(1),
      }),
      await json(c),
    );
    return orderAction(c, (o) => fulfil(o, items));
  });
  admin.post("/orders/:id/complete", (c) =>
    orderAction(c, (o) => transitionLifecycle(o, "completed")),
  );

  /** Raw body upload: size is capped while streaming (see `bodyLimit`), type is sniffed from the bytes. */
  const readUpload = async (
    c: Context<AppEnv>,
    prefix: string,
    types: string[],
    maxBytes: number,
  ) => {
    const declared = c.req.header("content-type")?.split(";")[0]?.trim();
    const body = new Uint8Array(await c.req.arrayBuffer());
    const { contentType, ext } = validateUpload(body, {
      maxBytes,
      allowedTypes: types,
      declaredType: declared,
    });
    const key = newStorageKey(prefix, ext);
    await d.storage.put(key, body, contentType);
    return { key, contentType, size: body.byteLength };
  };
  const limits = d.uploadLimits ?? { media: 5_000_000, asset: 50_000_000 };
  admin.post("/media", async (c) => {
    const file = await readUpload(c, "media", IMAGES, limits.media);
    change(c, `media/${file.key}`);
    return c.json(file, 201);
  });
  admin.delete("/media", async (c) => {
    const key = c.req.query("key") ?? "";
    if (!isSafeKey(key) || !key.startsWith("media/"))
      throw new HttpError("validation_failed", "Invalid key");
    await d.storage.delete(key);
    change(c, `media/${key}`);
    return c.json({ ok: true });
  });

  // Digital assets: the file is private and never returned; customers get it only through a download grant.
  // Replacing swaps the file under the same id, so grants already sold keep working.
  const assetView = ({ storageKey: _key, ...asset }: DigitalAsset) => asset;
  const assetUpload = async (c: Context<AppEnv>) => {
    const { filename } = parse(
      z.strictObject({ filename: AssetName }),
      c.req.query(),
    );
    const file = await readUpload(c, "assets", ASSETS, limits.asset);
    return {
      filename,
      storageKey: file.key,
      contentType: file.contentType,
      size: file.size,
    };
  };
  admin.get("/digital-assets", async (c) => {
    const page = await d.db.assets.list(parse(PageQuery, c.req.query()));
    return c.json({ ...page, items: page.items.map(assetView) });
  });
  admin.get("/digital-assets/:id", async (c) => {
    const found = await d.db.assets.get(c.req.param("id"));
    if (!found) throw new HttpError("not_found", "Asset not found");
    return c.json(assetView(found));
  });
  admin.post("/digital-assets", async (c) => {
    const asset = await d.downloads.createAsset(await assetUpload(c));
    change(c, `digital-assets/${asset.id}`);
    return c.json(assetView(asset), 201);
  });
  admin.put("/digital-assets/:id", async (c) => {
    const file = await assetUpload(c);
    const asset = await d.downloads.replaceAsset(c.req.param("id"), file);
    if (!asset) {
      await d.storage.delete(file.storageKey); // nothing to replace: do not keep the orphan upload
      throw new HttpError("not_found", "Asset not found");
    }
    change(c, `digital-assets/${asset.id}`);
    return c.json(assetView(asset));
  });

  // Keys: the secret appears only in the create/rotate response, which idempotency never stores. The key
  // store is separate from `db`, so the audit entry is appended here and `undo` compensates if it fails:
  // a key is never left active with its secret undelivered.
  const auditKey = async (
    c: Context<AppEnv>,
    target: string,
    after: unknown,
    undo: () => Promise<void>,
  ) => {
    try {
      await d.db.audit.append(
        newAuditEntry(
          {
            actor: actorOf(c),
            action: `${c.req.method} ${c.req.routePath}`,
            target,
            after,
          },
          now(),
        ),
      );
    } catch (err) {
      await undo();
      throw err;
    }
    c.set("audited", true);
    c.set("sensitive", true);
  };
  admin.get("/api-keys", async (c) => {
    const page = await d.apiKeys.list(parse(PageQuery, c.req.query()));
    return c.json({ ...page, items: page.items.map(keyView) });
  });
  admin.post("/api-keys", async (c) => {
    const { key, secret } = await createApiKey(
      d.apiKeys,
      parse(NewKey, await json(c)),
      now(),
    );
    await auditKey(
      c,
      `api-keys/${key.id}`,
      { type: key.type, scopes: key.scopes },
      () => revokeApiKey(d.apiKeys, key.id, now()),
    );
    return c.json({ ...keyView(key), secret }, 201);
  });
  admin.post("/api-keys/:id/rotate", async (c) => {
    const { graceSeconds } = parse(
      z.strictObject({
        graceSeconds: z
          .number()
          .int()
          .min(0)
          .max(30 * 86_400)
          .default(0),
      }),
      await json(c),
    );
    const id = c.req.param("id");
    const old = await d.apiKeys.get(id);
    const { key, secret } = await rotateApiKey(
      d.apiKeys,
      id,
      graceSeconds * 1000,
      now(),
    );
    await auditKey(c, `api-keys/${id}`, { replacedBy: key.id }, async () => {
      await revokeApiKey(d.apiKeys, key.id, now());
      if (old) await d.apiKeys.save(old);
    });
    return c.json({ ...keyView(key), secret }, 201);
  });
  admin.post("/api-keys/:id/revoke", async (c) => {
    await revokeApiKey(d.apiKeys, c.req.param("id"), now());
    change(c, `api-keys/${c.req.param("id")}`);
    return c.json({ ok: true });
  });
};

import {
  addLine,
  cartTotals,
  createCart,
  eraseCustomer,
  exportCustomerData,
  getCart,
  type Repositories,
  removeLine,
  updateLine,
} from "@free-commerce/core";
import {
  CartId,
  CurrencyCode,
  idSchema,
  Product,
  ProductId,
  SearchQuery,
  VariantId,
} from "@free-commerce/schema";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { requireCustomer } from "./auth.js";
import { HttpError, parse } from "./errors.js";
import type { AppEnv } from "./types.js";

/** Query strings are flat: `option.Color=Red,Blue`, `priceMin`, `priceMax`; everything else is a plain field. */
const searchParams = (q: Record<string, string>) => {
  const { priceMin, priceMax, available, ...rest } = q;
  const options: Record<string, string[]> = {};
  const plain: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest))
    if (k.startsWith("option.")) options[k.slice(7)] = v.split(",");
    else plain[k] = v;
  const num = (v?: string) => (v === undefined ? undefined : Number(v));
  return {
    ...plain,
    ...(Object.keys(options).length > 0 && { options }),
    ...(available !== undefined && { available: available === "true" }),
    ...((priceMin ?? priceMax) !== undefined && {
      price: { min: num(priceMin), max: num(priceMax) },
    }),
  };
};

const json = async (c: { req: { json(): Promise<unknown> } }) =>
  c.req.json().catch(() => undefined);

const AddLine = z.strictObject({
  productId: ProductId,
  variantId: VariantId,
  quantity: z.number().int().positive(),
  /** Only for `customer_defined` variants. */
  amount: z.number().int().nonnegative().optional(),
});

export const mountStoreRoutes = (app: Hono<AppEnv>, d: AppDeps): void => {
  const store = app.basePath("/store");
  const now = d.now ?? Date.now;
  const clock = () => new Date(now());
  const view = (cart: Awaited<ReturnType<typeof getCart>>) => ({
    ...cart,
    totals: cartTotals(cart),
  });

  store.get("/products", async (c) => {
    const query = parse(SearchQuery, searchParams(c.req.query()));
    const { items: ids, nextCursor } = await d.search.search(query);
    const found = await Promise.all(ids.map((id) => d.db.products.get(id)));
    return c.json({
      items: found.flatMap((p) => (p?.status === "active" ? [p] : [])),
      nextCursor,
    });
  });

  store.get("/products/:id", async (c) => {
    const product = await d.db.products.get(
      parse(ProductId, c.req.param("id")),
    );
    if (product?.status !== "active")
      throw new HttpError("not_found", "Product not found");
    return c.json(product);
  });

  // Carts are bearer-by-id: the id is 80 random bits, so holding it is the permission to edit it.
  store.post("/carts", async (c) => {
    const { currency } = parse(
      z.strictObject({ currency: CurrencyCode }),
      await json(c),
    );
    return c.json(view(await createCart(d.db.carts, currency, clock())), 201);
  });
  store.get("/carts/:id", async (c) =>
    c.json(view(await getCart(d.db.carts, parse(CartId, c.req.param("id"))))),
  );

  // Read-modify-write runs in a transaction so two concurrent edits cannot lose a line.
  const edit = (
    id: string,
    change: (
      cart: Awaited<ReturnType<typeof getCart>>,
      tx: Repositories,
    ) => Promise<Awaited<ReturnType<typeof getCart>>>,
  ) =>
    d.db.transaction(async (tx) => {
      const cart = await change(await getCart(tx.carts, parse(CartId, id)), tx);
      await tx.carts.save(cart);
      return view(cart);
    });

  store.post("/carts/:id/lines", async (c) => {
    const body = parse(AddLine, await json(c));
    return c.json(
      await edit(c.req.param("id"), async (cart, tx) => {
        const product = await tx.products.get(body.productId);
        if (!product) throw new HttpError("not_found", "Product not found");
        return addLine(
          cart,
          Product.parse(product),
          body.variantId,
          body.quantity,
          body.amount,
          clock(),
        );
      }),
      201,
    );
  });
  store.patch("/carts/:id/lines/:lineId", async (c) => {
    const { quantity } = parse(
      z.strictObject({ quantity: z.number().int().positive() }),
      await json(c),
    );
    return c.json(
      await edit(c.req.param("id"), async (cart) =>
        updateLine(
          cart,
          parse(idSchema("line"), c.req.param("lineId")),
          quantity,
          clock(),
        ),
      ),
    );
  });
  store.delete("/carts/:id/lines/:lineId", async (c) =>
    c.json(
      await edit(c.req.param("id"), async (cart) =>
        removeLine(
          cart,
          parse(idSchema("line"), c.req.param("lineId")),
          clock(),
        ),
      ),
    ),
  );

  store.get("/customers/me", requireCustomer, (c) =>
    c.json({ id: c.var.auth.customer?.userId }),
  );
  // Only the session's own customer: there is no id in the path to tamper with.
  const me = (c: Context<AppEnv>) => {
    const id = c.var.auth.customer?.userId ?? "";
    return { id, actor: { type: "user", id } as const };
  };
  const personal = { db: d.db, auth: d.auth, hooks: d.personalData, now };
  store.get("/customers/me/export", requireCustomer, async (c) => {
    const { id, actor } = me(c);
    return c.json(await exportCustomerData(personal, id, actor));
  });
  // Irreversible, so a stolen session is not enough: the password is checked again, and tries are limited.
  store.post("/customers/me/erase", requireCustomer, async (c) => {
    const { password } = parse(
      z.strictObject({ password: z.string().min(1).max(256) }),
      await json(c),
    );
    const { id, actor } = me(c);
    const { count } = await d.rateLimit.hit(`erase:${id}`, 15 * 60_000);
    if (count > 5) throw new HttpError("rate_limited", "Too many attempts");
    const email = (await d.db.customers.get(id))?.email;
    const ok = email && (await d.auth.signIn("customer", { email, password }));
    if (!ok) throw new HttpError("unauthenticated", "Password required");
    return c.json(await eraseCustomer(personal, id, actor));
  });
  store.get("/orders", requireCustomer, async (c) =>
    c.json(await d.customerOrders(c.var.auth.customer?.userId ?? "")),
  );
  store.get("/orders/:id", requireCustomer, async (c) => {
    const orders = await d.customerOrders(c.var.auth.customer?.userId ?? "");
    const order = orders.find((o) => o.id === c.req.param("id"));
    if (!order) throw new HttpError("not_found", "Order not found");
    return c.json(order);
  });
};

import type {
  DeliveryType,
  FulfilmentStatus,
  OrderStatus,
  PaymentStatus,
} from "@free-commerce/schema";
import { newId, Order } from "@free-commerce/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FULFILMENT_TRANSITIONS,
  fulfil,
  LIFECYCLE_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  type Result,
  refundOrder,
  settle,
  transitionLifecycle,
  transitionPayment,
} from "./machines";

const LIFECYCLE: OrderStatus[] = ["draft", "open", "completed", "cancelled"];
const PAYMENT: PaymentStatus[] = [
  "unpaid",
  "requires_action",
  "pending",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
];

const usd = (amount: number) => ({ amount, currency: "USD" });
const ts = "2026-01-01T00:00:00.000Z";

const line = (deliveryType: DeliveryType, quantity = 2, fulfilled = 0) => ({
  id: newId("line"),
  title: "Item",
  deliveryType,
  quantity,
  fulfilled,
  unitPrice: usd(500),
});

const make = (over: Partial<Order> = {}): Order => {
  const lines = over.lines ?? [line("physical")];
  const base: Order = {
    id: newId("ord"),
    number: 1,
    status: "open",
    paymentStatus: "unpaid",
    fulfilmentStatus: "unfulfilled",
    lines,
    total: usd(1000),
    paid: usd(0),
    refunded: usd(0),
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
  return Order.parse(base);
};

const ok = (r: Result) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.order;
};

const pairs = <T>(xs: readonly T[]) =>
  xs.flatMap((from) => xs.map((to) => [from, to] as const));

describe("transition tables (matrix)", () => {
  // Lifecycle edges that are in the table can still be refused by a guard (covered below);
  // edges outside the table must always be refused as not_allowed.
  it.each(
    pairs(LIFECYCLE).filter(([f, t]) => !LIFECYCLE_TRANSITIONS[f].includes(t)),
  )("lifecycle %s -> %s is illegal", (from, to) => {
    expect(transitionLifecycle(make({ status: from }), to)).toEqual({
      ok: false,
      error: { machine: "lifecycle", from, to, reason: "not_allowed" },
    });
  });

  it.each(
    pairs(LIFECYCLE).filter(
      ([f, t]) => LIFECYCLE_TRANSITIONS[f].includes(t) && t !== "completed",
    ),
  )("lifecycle %s -> %s is legal on a clean order", (from, to) => {
    expect(ok(transitionLifecycle(make({ status: from }), to)).status).toBe(to);
  });

  const heldMoney = (from: PaymentStatus) => {
    const captured = ["paid", "partially_refunded", "refunded"].includes(from);
    return {
      paid: usd(captured ? 1000 : 0),
      refunded: usd(from === "refunded" ? 1000 : 0),
    };
  };
  const isRefundTarget = (to: PaymentStatus) =>
    to === "partially_refunded" || to === "refunded";

  // Refund targets are reached only via refundOrder, never via transitionPayment.
  it.each(
    pairs(PAYMENT).filter(
      ([f, t]) => PAYMENT_TRANSITIONS[f].includes(t) && !isRefundTarget(t),
    ),
  )("payment %s -> %s is legal", (from, to) => {
    const o = make({ paymentStatus: from, ...heldMoney(from) });
    expect(ok(transitionPayment(o, to)).paymentStatus).toBe(to);
  });

  it.each(
    pairs(PAYMENT).filter(
      ([f, t]) => !PAYMENT_TRANSITIONS[f].includes(t) || isRefundTarget(t),
    ),
  )("payment %s -> %s is illegal", (from, to) => {
    const o = make({ paymentStatus: from, ...heldMoney(from) });
    expect(transitionPayment(o, to)).toEqual({
      ok: false,
      error: { machine: "payment", from, to, reason: "not_allowed" },
    });
  });

  it.each([
    ["unfulfilled", "unfulfilled", false],
    ["unfulfilled", "partially_fulfilled", true],
    ["unfulfilled", "fulfilled", true],
    ["partially_fulfilled", "unfulfilled", false],
    ["partially_fulfilled", "partially_fulfilled", true],
    ["partially_fulfilled", "fulfilled", true],
    ["fulfilled", "unfulfilled", false],
    ["fulfilled", "partially_fulfilled", false],
    ["fulfilled", "fulfilled", false],
  ] as const)("fulfilment %s -> %s legal=%s", (from, to, legal) => {
    expect(FULFILMENT_TRANSITIONS[from].includes(to)).toBe(legal);
  });
});

describe("lifecycle guards", () => {
  it("draft opens; open cancels when nothing is captured", () => {
    expect(
      ok(transitionLifecycle(make({ status: "draft" }), "open")).status,
    ).toBe("open");
    expect(ok(transitionLifecycle(make(), "cancelled")).status).toBe(
      "cancelled",
    );
    expect(
      ok(transitionLifecycle(make({ status: "draft" }), "cancelled")).status,
    ).toBe("cancelled");
  });

  it("refuses completing unpaid or unfulfilled orders", () => {
    expect(transitionLifecycle(make(), "completed")).toMatchObject({
      ok: false,
      error: { reason: "payment_not_captured", from: "open", to: "completed" },
    });
    const paid = make({ paymentStatus: "paid", paid: usd(1000) });
    expect(transitionLifecycle(paid, "completed")).toMatchObject({
      ok: false,
      error: { reason: "not_fully_fulfilled" },
    });
  });

  it("refuses cancelling captured or in-flight payments, and fulfilled orders", () => {
    for (const paymentStatus of [
      "requires_action",
      "pending",
      "paid",
      "partially_refunded",
    ] as const)
      expect(
        transitionLifecycle(make({ paymentStatus }), "cancelled"),
      ).toMatchObject({
        ok: false,
        error: { reason: "payment_unsettled" },
      });
    const fulfilled = make({
      paymentStatus: "refunded",
      paid: usd(1000),
      refunded: usd(1000),
      fulfilmentStatus: "fulfilled",
      lines: [line("physical", 2, 2)],
    });
    expect(transitionLifecycle(fulfilled, "cancelled")).toMatchObject({
      ok: false,
      error: { reason: "already_fulfilled" },
    });
  });

  it("a refunded, unfulfilled order can be cancelled", () => {
    const o = make({
      paymentStatus: "refunded",
      paid: usd(1000),
      refunded: usd(1000),
    });
    expect(ok(transitionLifecycle(o, "cancelled")).status).toBe("cancelled");
  });
});

describe("payment guards and automatic fulfilment", () => {
  it("requires an open order", () => {
    for (const status of ["draft", "completed", "cancelled"] as const)
      expect(transitionPayment(make({ status }), "pending")).toMatchObject({
        ok: false,
        error: { reason: "order_not_open", from: "unpaid", to: "pending" },
      });
  });

  it("paying a digital/none-only order fulfils it and completes it", () => {
    const o = make({ lines: [line("digital"), line("none", 1)] });
    const done = ok(transitionPayment(o, "paid"));
    expect(done).toMatchObject({
      paid: usd(1000),
      status: "completed",
      fulfilmentStatus: "fulfilled",
    });
  });

  it("paying a mixed order fulfils only digital/none lines", () => {
    const o = make({ lines: [line("physical"), line("digital")] });
    const paid = ok(transitionPayment(o, "paid"));
    expect(paid).toMatchObject({
      status: "open",
      fulfilmentStatus: "partially_fulfilled",
    });
    expect(paid.lines.map((l) => l.fulfilled)).toEqual([0, 2]);
  });

  it("settle on a cart-born paid order is idempotent", () => {
    const o = make({
      paymentStatus: "paid",
      paid: usd(1000),
      lines: [line("digital")],
    });
    const once = settle(o);
    expect(once.status).toBe("completed");
    expect(settle(once)).toEqual(once);
  });
});

describe("refunds", () => {
  const paid = () => make({ paymentStatus: "paid", paid: usd(1000) });

  it("partial then full", () => {
    const part = ok(refundOrder(paid(), usd(400)));
    expect(part).toMatchObject({
      paymentStatus: "partially_refunded",
      refunded: usd(400),
    });
    expect(ok(refundOrder(part, usd(600)))).toMatchObject({
      paymentStatus: "refunded",
      refunded: usd(1000),
    });
  });

  it("refuses every bad refund", () => {
    const err = (o: Order, a: { amount: number; currency: string }) => {
      const r = refundOrder(o, a);
      return r.ok ? null : r.error.reason;
    };
    expect(err(paid(), usd(1001))).toBe("refund_exceeds_paid");
    expect(err(paid(), usd(0))).toBe("invalid_quantity");
    expect(err(paid(), usd(-5))).toBe("invalid_quantity");
    expect(err(paid(), usd(1.5))).toBe("invalid_quantity");
    expect(err(paid(), { amount: 1, currency: "EUR" })).toBe(
      "currency_mismatch",
    );
    expect(err(make(), usd(1))).toBe("not_allowed");
    expect(
      err(
        make({
          paymentStatus: "refunded",
          paid: usd(1000),
          refunded: usd(1000),
        }),
        usd(1),
      ),
    ).toBe("not_allowed");
  });
});

describe("fulfil", () => {
  const paidPhysical = () =>
    make({
      paymentStatus: "paid",
      paid: usd(1000),
      lines: [line("physical", 3)],
    });

  it("partial then full completes the order", () => {
    const o = paidPhysical();
    const id = o.lines[0]?.id ?? "";
    const half = ok(fulfil(o, [{ lineId: id, quantity: 1 }]));
    expect(half).toMatchObject({
      fulfilmentStatus: "partially_fulfilled",
      status: "open",
    });
    expect(ok(fulfil(half, [{ lineId: id, quantity: 2 }]))).toMatchObject({
      fulfilmentStatus: "fulfilled",
      status: "completed",
    });
  });

  it("refuses every bad request and leaves the order untouched", () => {
    const o = paidPhysical();
    const id = o.lines[0]?.id ?? "";
    const before = structuredClone(o);
    const reason = (r: Result, order = o) => {
      expect(order).toEqual(before);
      return r.ok ? null : r.error.reason;
    };
    expect(reason(fulfil(o, [{ lineId: id, quantity: 4 }]))).toBe(
      "invalid_quantity",
    );
    expect(
      reason(
        fulfil(o, [
          { lineId: id, quantity: 2 },
          { lineId: id, quantity: 2 },
        ]),
      ),
    ).toBe("invalid_quantity");
    expect(reason(fulfil(o, [{ lineId: id, quantity: 0 }]))).toBe(
      "invalid_quantity",
    );
    expect(reason(fulfil(o, [{ lineId: id, quantity: 1.5 }]))).toBe(
      "invalid_quantity",
    );
    expect(reason(fulfil(o, []))).toBe("invalid_quantity");
    expect(reason(fulfil(o, [{ lineId: "line_x", quantity: 1 }]))).toBe(
      "unknown_line",
    );
    expect(
      fulfil(make({ lines: [line("physical")] }), [
        { lineId: id, quantity: 1 },
      ]),
    ).toMatchObject({
      error: { reason: "payment_not_captured" },
    });
    expect(
      fulfil(
        make({ status: "draft", paymentStatus: "paid", paid: usd(1000) }),
        [],
      ),
    ).toMatchObject({
      error: { reason: "order_not_open" },
    });
    const full = fulfil(o, [{ lineId: id, quantity: 3 }]);
    expect(
      full.ok && fulfil({ ...full.order, status: "open" }, []),
    ).toMatchObject({
      error: { reason: "already_fulfilled", from: "fulfilled" },
    });
  });
});

type Cmd =
  | { t: "open" }
  | { t: "pay"; to: PaymentStatus }
  | { t: "refund"; amount: number }
  | { t: "fulfil"; line: number; quantity: number }
  | { t: "lifecycle"; to: OrderStatus };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.constant<Cmd>({ t: "open" }),
  fc.constantFrom(...PAYMENT).map((to): Cmd => ({ t: "pay", to })),
  fc
    .integer({ min: -10, max: 1200 })
    .map((amount): Cmd => ({ t: "refund", amount })),
  fc
    .record({ line: fc.nat(3), quantity: fc.integer({ min: -1, max: 4 }) })
    .map((r): Cmd => ({ t: "fulfil", ...r })),
  fc.constantFrom(...LIFECYCLE).map((to): Cmd => ({ t: "lifecycle", to })),
);

const apply = (o: Order, c: Cmd): Result => {
  switch (c.t) {
    case "open":
      return transitionLifecycle(o, "open");
    case "pay":
      return transitionPayment(o, c.to);
    case "refund":
      return refundOrder(o, usd(c.amount));
    case "fulfil":
      return fulfil(o, [
        {
          lineId: o.lines[c.line % o.lines.length]?.id ?? "",
          quantity: c.quantity,
        },
      ]);
    case "lifecycle":
      return transitionLifecycle(o, c.to);
  }
};

const derive = (o: Order): FulfilmentStatus => {
  if (o.lines.every((l) => l.fulfilled === l.quantity)) return "fulfilled";
  return o.lines.some((l) => l.fulfilled > 0)
    ? "partially_fulfilled"
    : "unfulfilled";
};

const isCaptured = (o: Order) =>
  ["paid", "partially_refunded", "refunded"].includes(o.paymentStatus);

const follows = <T extends string>(
  table: Record<T, readonly T[]>,
  from: T,
  to: T,
) => from === to || table[from].includes(to);

/** Each machine only moves along its own table. */
const assertTables = (o: Order, n: Order) => {
  expect(follows(LIFECYCLE_TRANSITIONS, o.status, n.status)).toBe(true);
  expect(follows(PAYMENT_TRANSITIONS, o.paymentStatus, n.paymentStatus)).toBe(
    true,
  );
  expect(
    follows(FULFILMENT_TRANSITIONS, o.fulfilmentStatus, n.fulfilmentStatus),
  ).toBe(true);
};

/** Combined-state rules across the three machines. */
const assertCombined = (n: Order) => {
  if (n.status === "completed") {
    expect(isCaptured(n)).toBe(true);
    expect(n.fulfilmentStatus).toBe("fulfilled");
  }
  if (n.status === "cancelled")
    expect(n.fulfilmentStatus).not.toBe("fulfilled");
  if (n.fulfilmentStatus !== "unfulfilled" && n.status !== "cancelled")
    expect(isCaptured(n)).toBe(true);
};

const assertMoney = (n: Order) => {
  expect(n.refunded.amount).toBeLessThanOrEqual(n.paid.amount);
  expect(n.paid.amount).toBeLessThanOrEqual(n.total.amount);
  expect(Number.isInteger(n.refunded.amount)).toBe(true);
  if (n.paymentStatus === "refunded")
    expect(n.refunded.amount).toBe(n.paid.amount);
  if (n.paymentStatus === "partially_refunded") {
    expect(n.refunded.amount).toBeGreaterThan(0);
    expect(n.refunded.amount).toBeLessThan(n.paid.amount);
  }
};

/** Derived status matches lines; digital/none lines are fulfilled once captured. */
const assertFulfilment = (n: Order) => {
  expect(n.fulfilmentStatus).toBe(derive(n));
  for (const l of n.lines) {
    expect(l.fulfilled).toBeLessThanOrEqual(l.quantity);
    if (isCaptured(n) && l.deliveryType !== "physical")
      expect(l.fulfilled).toBe(l.quantity);
  }
};

const start = () =>
  make({
    status: "draft",
    lines: [
      line("physical"),
      line("digital", 1),
      line("none", 1),
      line("physical", 3),
    ],
  });

describe("invariants over random legal sequences", () => {
  it("never reaches an illegal combined state", () => {
    fc.assert(
      fc.property(fc.array(cmd, { maxLength: 30 }), (cmds) => {
        let o = start();
        for (const c of cmds) {
          const before = structuredClone(o);
          const r = apply(o, c);
          expect(r.ok || o).toEqual(r.ok || before); // refusals are pure
          if (!r.ok) continue;
          assertTables(o, r.order);
          assertCombined(r.order);
          assertMoney(r.order);
          assertFulfilment(r.order);
          o = r.order;
        }
      }),
      { numRuns: 300 },
    );
  });
});

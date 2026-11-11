import type { Saga } from "./runner";

export interface CheckoutInput {
  cartId: string;
  amount: number;
}

/** Narrow service ports for the demo; every call takes the step's idempotency key. */
export interface CheckoutDeps {
  reserveStock(key: string, cartId: string): Promise<string>;
  releaseStock(key: string, reservationId: string): Promise<void>;
  createPayment(key: string, amount: number): Promise<string>;
  cancelPayment(key: string, paymentId: string): Promise<void>;
  confirmOrder(key: string, cartId: string, paymentId: string): Promise<string>;
}

/** Demo saga mirroring the domain-model checkout: reserve, pay, await webhook, confirm. */
export function completeCheckout(d: CheckoutDeps): Saga<CheckoutInput> {
  return {
    name: "completeCheckout",
    steps: [
      {
        name: "reserve-stock",
        run: (c) => d.reserveStock(c.key, c.input.cartId),
        compensate: (c, r) => d.releaseStock(c.key, r as string),
      },
      {
        name: "create-payment",
        retries: 2,
        run: (c) => d.createPayment(c.key, c.input.amount),
        compensate: (c, r) => d.cancelPayment(c.key, r as string),
      },
      {
        name: "await-payment",
        waitFor: { event: "payment.succeeded", timeoutMs: 30 * 60_000 },
      },
      {
        name: "confirm-order",
        run: (c) =>
          d.confirmOrder(
            c.key,
            c.input.cartId,
            c.results["create-payment"] as string,
          ),
      },
    ],
  };
}

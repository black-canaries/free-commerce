import { ProviderError } from "./error";
import { assertChargeable, type PaymentProvider } from "./payment";

const NAME = "manual-payments";
const unsupported = (what: string) => (): Promise<never> =>
  Promise.reject(new ProviderError(NAME, "rejected", `${what} unsupported`));

/**
 * @experimental Bank transfer, cash and other payments an admin marks paid.
 * Stateless: ids derive from idempotency keys, so replays are free, and `capture`
 * is the admin's "mark paid". Having no store, it cannot reject a reused key with different input
 * or check currency/limits against the payment: the caller (task 2.8 order actions) must.
 * Has no remote state: skip it in reconciliation (`retrieve` is unsupported).
 */
export function createManualPayments(): PaymentProvider {
  return {
    async createPayment(i) {
      assertChargeable(NAME, i.amount);
      return {
        id: `manual_${i.idempotencyKey}`,
        state: "pending",
        amount: i.amount,
      };
    },
    async capture(i) {
      assertChargeable(NAME, i.amount);
      return { id: i.paymentId, state: "captured", amount: i.amount };
    },
    async refund(i) {
      assertChargeable(NAME, i.amount);
      return {
        id: `manual_refund_${i.idempotencyKey}`,
        amount: i.amount,
        state: "succeeded",
      };
    },
    confirm: unsupported("confirm"),
    retrieve: unsupported("retrieve"),
    chargeSavedMethod: unsupported("saved methods"),
    verifyWebhook: unsupported("webhooks"),
  };
}

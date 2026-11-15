import type { Money } from "@free-commerce/schema";
import { ProviderError } from "./error";

/** @experimental Lifecycle of one payment attempt at the provider. */
export type PaymentState =
  | "requires_action" // customer must supply a method, authenticate (3DS) or follow a redirect
  | "pending" // submitted; an asynchronous method (bank debit, wallet) has not settled
  | "authorized" // funds held, not yet captured (manual capture)
  | "captured" // money taken
  | "failed"; // declined, expired or abandoned; terminal

/**
 * Forward moves only. Webhooks arrive late and out of order: apply an update
 * only when the new state is listed here for the stored one, otherwise ignore it.
 * @experimental
 */
export const PAYMENT_STATE_TRANSITIONS: Record<
  PaymentState,
  readonly PaymentState[]
> = {
  requires_action: ["pending", "authorized", "captured", "failed"],
  pending: ["authorized", "captured", "failed"],
  authorized: ["captured", "failed"],
  captured: [],
  failed: [],
};

/** What the customer's device must do next. Never contains card data. */
export type PaymentAction =
  | { type: "client"; clientSecret: string } // hand to the provider's client SDK
  | { type: "redirect"; url: string };

/** @experimental `amount` is what is held or taken (after a partial capture, the captured part). */
export interface Payment {
  id: string;
  state: PaymentState;
  amount: Money;
  /** Present while `state` is `requires_action`. */
  action?: PaymentAction;
  /** Reusable token for `chargeSavedMethod`; set once a method was saved and the payment succeeded. */
  savedMethodId?: string;
  /** Provider's decline/expiry code when `failed`. */
  failureCode?: string;
}

/** @experimental `pending` is an asynchronous refund not yet settled. */
export interface Refund {
  id: string;
  amount: Money;
  state: "pending" | "succeeded" | "failed";
}

/** @experimental Verified inbound webhook: a snapshot of the payment (and refund) it concerns. */
export interface PaymentEvent {
  /** Provider's unique event id; consumers dedupe on it (deliveries repeat). */
  id: string;
  payment: Payment;
  refund?: Refund;
}

/** Every mutating call carries a caller-chosen key; replaying it returns the first result. */
interface Idempotent {
  idempotencyKey: string;
}

/**
 * @experimental Card-not-present payments. Adapters never see raw card data:
 * the customer's device talks to the provider and we handle opaque tokens only.
 *
 * Idempotency: repeating a mutating call with the same key and the same input
 * returns the original result; the same key with different input is `rejected`.
 * Errors are `ProviderError` (a declined payment is a `failed` Payment, not an error).
 * Nothing here assumes one-time charges; see ADR 0022 for recurring billing.
 */
export interface PaymentProvider {
  /** `captureMode: "manual"` holds funds (`authorized`) until `capture`. */
  createPayment(
    input: Idempotent & {
      amount: Money;
      /** Our reference (order or cart id), echoed back by the provider where supported. */
      reference: string;
      captureMode?: "automatic" | "manual";
      /** Ask the provider to keep the method for `chargeSavedMethod`; needs `customerRef`. */
      saveMethod?: boolean;
      customerRef?: string;
    },
  ): Promise<Payment>;
  /** Server-side confirm with a provider-issued `methodToken`; client-side confirm needs no call. */
  confirm(
    input: Idempotent & {
      paymentId: string;
      methodToken: string;
      returnUrl?: string;
    },
  ): Promise<Payment>;
  /** Current provider-side truth, for reconciliation. Throws `not_found` for unknown ids. */
  retrieve(paymentId: string): Promise<Payment>;
  /** Takes money from an `authorized` payment; `amount` ≤ authorized, the rest is released. */
  capture(
    input: Idempotent & { paymentId: string; amount: Money },
  ): Promise<Payment>;
  /** Total refunds of a payment never exceed what was captured. */
  refund(
    input: Idempotent & { paymentId: string; amount: Money },
  ): Promise<Refund>;
  /** Off-session charge with a saved method (one-click upsell). May return `requires_action` if the bank demands authentication. */
  chargeSavedMethod(
    input: Idempotent & {
      savedMethodId: string;
      customerRef: string;
      amount: Money;
      reference: string;
    },
  ): Promise<Payment>;
  /**
   * Verifies the signature over the exact raw body (never re-serialised JSON)
   * and parses it. Throws `ProviderError("rejected")` on a bad or missing signature.
   * Header names are lower-case.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<PaymentEvent>;
}

/** Shared by adapters: whole, positive, safe minor units with an ISO 4217-shaped currency. */
export function assertChargeable(provider: string, m: Money): void {
  if (
    !Number.isSafeInteger(m.amount) ||
    m.amount <= 0 ||
    !/^[A-Z]{3}$/.test(m.currency)
  )
    throw new ProviderError(provider, "rejected", "invalid amount");
}

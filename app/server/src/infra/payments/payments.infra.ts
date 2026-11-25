// The payment provider, as the billing service sees it (spec 74.5): Silo's own platform
// supplier for subscriptions, invoices and payments. The billing
// service works only with these neutral shapes; the provider's own API, its event names and
// its signature scheme stay inside this folder. Nothing else in the product reads payments
// (spec 71.4): it reads entitlements.

import type { PaymentsConfig } from '../../config/payments.config.ts';
import { createStripePayments } from './stripe.infra.ts';

export type ProviderSubscriptionStatus =
  | 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';

export interface PaymentSubscription {
  id: string;
  customerId: string;
  status: ProviderSubscriptionStatus;
  /** The price of the subscription's one item; plan and term follow from it. */
  priceId: string | undefined;
  /** Seats. */
  quantity: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelledAt: string | null;
  metadata: Readonly<Record<string, string>>;
}

export interface PaymentInvoice {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  /** Minor units (pence). */
  amountDue: number;
  currency: string;
  /** The service period the invoice bills. */
  periodStart: string;
  periodEnd: string;
  /** YYYY-MM-DD, for an invoice sent with terms; null when charged automatically. */
  dueDate: string | null;
  createdAt: string;
  paidAt: string | null;
  collection: 'automatic' | 'send_invoice';
  daysUntilDue: number | null;
  metadata: Readonly<Record<string, string>>;
}

/** A verified webhook event, reduced to what billing acts on. */
export type PaymentEvent =
  | { id: string; kind: 'subscription'; subscriptionId: string; metadata: Readonly<Record<string, string>> }
  | { id: string; kind: 'invoice'; invoice: PaymentInvoice }
  | { id: string; kind: 'other' };

export interface ChargeOutcome {
  invoiceId: string;
  outcome: 'paid' | 'declined' | 'requires_action';
}

export interface PaymentProvider {
  /** Verifies the signature over the raw payload and its age, then reads the event. Throws unauthenticated. */
  verifyEvent(payload: string, signatureHeader: string): PaymentEvent;
  createCustomer(input: { organisationId: string; cellId: string; name: string }, idempotencyKey: string): Promise<{ id: string }>;
  customerMetadata(customerId: string): Promise<Readonly<Record<string, string>>>;
  createCheckout(input: {
    customerId: string; priceId: string; quantity: number; organisationId: string; cellId: string; successUrl: string; cancelUrl: string;
  }, idempotencyKey: string): Promise<{ id: string; url: string }>;
  getCheckout(id: string): Promise<{ id: string; url: string }>;
  createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  getSubscription(id: string): Promise<PaymentSubscription>;
  /**
   * The subscription's seat count (72.2, 74.5). prorate: the change is billed for the rest of
   * the period and invoiced now (an addition); otherwise it applies from the next period with
   * no refund (a release).
   */
  setSubscriptionQuantity(subscriptionId: string, quantity: number, prorate: boolean, idempotencyKey: string): Promise<PaymentSubscription>;
  /** One immediate payment with the customer's default payment method, as a paid invoice. */
  chargeOnce(input: {
    customerId: string; amountMinor: number; currency: string; description: string; metadata: Record<string, string>;
  }, idempotencyKey: string): Promise<ChargeOutcome>;
  /**
   * An Enterprise invoice (74.5): Stripe Invoicing without a subscription, sent with payment
   * terms for bank transfer, its lines and the purchase order on it. Returned finalised and sent.
   */
  createContractInvoice(input: {
    customerId: string; currency: string; daysUntilDue: number; lines: readonly { description: string; amountMinor: number }[];
    purchaseOrder: string | undefined; periodStart: string; periodEnd: string; metadata: Record<string, string>;
  }, idempotencyKey: string): Promise<PaymentInvoice>;
  /**
   * A usage invoice in arrears (74.5: Siloes at cost plus 10%): its lines, for a service period.
   * A self-serve customer's card is charged automatically; an Enterprise customer's invoice is
   * sent with terms and the purchase order. Returned finalised.
   */
  createUsageInvoice(input: {
    customerId: string; currency: string; collection: { kind: 'automatic' } | { kind: 'send_invoice'; daysUntilDue: number };
    lines: readonly { description: string; amountMinor: number }[]; purchaseOrder: string | undefined;
    periodStart: string; periodEnd: string; metadata: Record<string, string>;
  }, idempotencyKey: string): Promise<PaymentInvoice>;
}

export function createPaymentProvider(config: PaymentsConfig): PaymentProvider {
  return createStripePayments(config);
}

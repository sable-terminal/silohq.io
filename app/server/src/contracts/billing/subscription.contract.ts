// Self-serve billing (spec 71.3, 72.1, 74.5): Standard and Business through the payment
// provider's hosted checkout and billing portal. The subscription, its entitlements and
// the billing status are written only when the provider's verified webhook arrives, never
// from these requests.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const timestamp = z.iso.datetime({ offset: true });

/**
 * billing.manage: start a subscription. 500 seats and above are quoted (72.1). auth starts
 * it as the founder when a self-serve sign-up completes (decision 2026-11-14).
 */
export const startCheckout = defineContract({
  service: 'billing', name: 'startCheckout', method: 'POST', path: '/v1/subscription/checkout', callers: ['gateway', 'auth'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    plan: z.enum(['standard', 'business']),
    term: z.enum(['monthly', 'annual']),
    seats: z.number().int().min(1).max(499),
  }),
  response: z.object({ checkoutId: z.string().regex(/^[A-Za-z0-9_]{1,255}$/), checkoutUrl: z.url() }),
  status: 201,
  maxBodyBytes: 512,
});

/** billing.manage: payment method, plan change, seats and cancellation, in the provider's portal. */
export const openBillingPortal = defineContract({
  service: 'billing', name: 'openBillingPortal', method: 'POST', path: '/v1/subscription/portal', callers: ['gateway'],
  // Opening a portal session changes nothing; each call gets a fresh short-lived link.
  context: 'organisation', idempotency: 'none',
  response: z.object({ portalUrl: z.url() }),
  status: 201,
});

const entitlementView = z.object({
  seats: z.number().int(),
  tokensPerSeatPeriod: z.number().int(),
  simulationsPerSeatPeriod: z.number().int(),
  dailyTokenLimit: z.number().int(),
  storageIncludedBytes: z.string(),
  capabilities: z.array(z.string()),
  /** Null: unlimited (D76). */
  connectionsLimit: z.number().int().nullable(),
  source: z.enum(['subscription', 'contract', 'sovereign_terms']),
  effectiveFrom: timestamp,
});

/** billing.view: the billing page. */
export const readBilling = defineContract({
  service: 'billing', name: 'readBilling', method: 'GET', path: '/v1/billing', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    billingStatus: z.enum(['active', 'past_due', 'suspended', 'cancelled']),
    subscription: z.object({
      plan: z.enum(['standard', 'business']),
      seatCount: z.number().int(),
      term: z.enum(['monthly', 'annual']),
      discountTier: z.enum(['list', 'tier_25_99', 'tier_100_249', 'tier_250_499', 'quoted']),
      currentPeriodStart: timestamp,
      currentPeriodEnd: timestamp,
      status: z.enum(['active', 'past_due', 'suspended', 'cancelled']),
    }).nullable(),
    entitlement: entitlementView.nullable(),
    invoices: z.array(z.object({
      id: z.uuid(),
      periodCovered: z.string(),
      amount: z.string(),
      currency: z.string(),
      status: z.enum(['draft', 'open', 'paid', 'overdue', 'void']),
      dueDate: z.iso.date(),
      paidAt: timestamp.nullable(),
    })),
  }),
});

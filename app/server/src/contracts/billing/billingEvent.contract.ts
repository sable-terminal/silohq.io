// The audit events of Part XI (spec 72.7, 73.9, 74.8, 75.5), as they cross from metering and billing to
// the audit ledger: written to the outbox in the transaction that made the change,
// published on bus-durable topic audit.events by the outbox relay, and stored in
// audit.audit_events by the audit service. References, counts and closed-set reasons only,
// never a record value.
//
// The message is the audit service's audit_event (contracts/audit/auditEvent.contract.ts),
// whose catalogue lists these names. The schema here is the narrower shape billing and
// metering write: their actors, and details without identifier lists.

import { z } from 'zod';

export const BILLING_EVENTS = [
  // Tokens and simulations (73.9)
  'tokens_purchased', 'auto_topup_toggled', 'allowance_granted', 'allowance_exhausted', 'daily_limit_reached',
  'engagement_cost_reported',
  // Siloes billing, contracts and the payment provider (74.8)
  'subscription_created', 'plan_changed', 'storage_measured', 'contract_created', 'contract_amended', 'contract_renewed',
  'contract_lapsed', 'margin_approval_requested', 'margin_approval_granted', 'invoice_raised', 'invoice_paid',
  'payment_recorded_manually', 'overage_reported',
  // A sovereign customer's entitlement terms in the sovereign cell, entered and decided by two cleared operators (D204).
  'sovereign_terms_entered', 'sovereign_terms_approved', 'sovereign_terms_rejected',
  // A closed month's Silo charges at cost plus 10% (74.1): invoiced, or recorded and not billed.
  'silo_charges_invoiced', 'silo_charges_not_billed',
  // Billing status (75.5)
  'billing_status_changed',
  // Purchased seats (72.2, 72.7): created and released as the subscription's count moves
  'seat_allocated', 'seat_released',
] as const;

export type BillingEventName = (typeof BILLING_EVENTS)[number];

const snake = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);

/** Who acted: exactly one actor arm of audit.audit_events. */
export const billingActor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('membership'), membershipId: z.uuid() }),
  z.strictObject({ kind: z.literal('service_principal'), servicePrincipalId: z.uuid() }),
  /** Silo staff on a staff path, under their operator session. */
  z.strictObject({ kind: z.literal('operator'), operatorId: z.uuid(), operatorAccessSessionId: z.uuid() }),
  /** A verified payment webhook, a usage message or a renewal: the service that wrote the change. */
  z.strictObject({ kind: z.literal('service'), service: z.enum(['billing', 'metering']) }),
]);

export const billingEventSchema = z.strictObject({
    event: z.enum(BILLING_EVENTS),
    actor: billingActor,
    /** The membership the event is about, when it is not the actor (a beneficiary). */
    subjectMembershipId: z.uuid().nullable(),
    scopeId: z.uuid().nullable(),
    resource: z.strictObject({ type: snake, id: z.uuid() }).nullable(),
    purposeSessionId: z.uuid().nullable(),
    operatorAccessSessionId: z.uuid().nullable(),
    ipHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    /** Closed-set reasons, counts and references. A staff reason is the operator's own words. */
    detail: z.record(snake, z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
});

export type BillingEvent = z.infer<typeof billingEventSchema>;
export type BillingActor = z.infer<typeof billingActor>;

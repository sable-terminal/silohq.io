// Silo staff paths, reached only from the admin portal under an operator session (spec
// 75.3). A tenant endpoint never writes billing
// status: a customer's own super admin must not be able to lift their own suspension.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/** A named staff identity and a reason move billing status, with the same event the webhook writes. */
export const setBillingStatus = defineContract({
  service: 'billing', name: 'setBillingStatus', method: 'POST', path: '/v1/billing-status', callers: ['admin-portal'],
  // Setting a status to what it already is changes nothing.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    status: z.enum(['active', 'past_due', 'suspended', 'cancelled']),
    reason: z.string().trim().min(3).max(200),
  }),
  response: z.object({ billingStatus: z.enum(['active', 'past_due', 'suspended', 'cancelled']), changed: z.boolean() }),
  maxBodyBytes: 2048,
});

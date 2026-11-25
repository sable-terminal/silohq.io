// Auto top-up's purchase (spec 73.4), asked by metering when a charge would be refused and
// the membership has auto top-up on. Billing charges the organisation's payment method at the
// top-up price (£20 per 100 tokens), then has metering credit the membership as an automatic
// purchase. Bounded: at most BILLING_AUTO_TOPUPS_PER_DAY top-ups per membership per day, so a
// runaway loop cannot spend without limit. Refusals name why: no payment method, a declined
// payment, or the day's limit.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const autoTopUp = defineContract({
  service: 'billing', name: 'autoTopUp', method: 'POST', path: '/v1/auto-topups', callers: ['metering'],
  // The purchase id is derived from requestKey, and every provider call is keyed from it: a
  // retry finds the same payment and credits once.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    membershipId: z.uuid(),
    tokens: z.int().min(100).max(1_000).refine((n) => n % 100 === 0, 'tokens are bought in hundreds'),
    requestKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,240}$/),
  }),
  response: z.object({ purchaseId: z.uuid(), tokens: z.int(), amount: z.string(), currency: z.string() }),
  status: 201,
  maxBodyBytes: 1_024,
});

// Buying tokens and simulations (spec 73.4, 73.8), under tokens.purchase. Top-up is £20 per
// 100 tokens with no expiry; the seat discount never applies to it (72.1). The payment is
// taken through the provider with the organisation's payment method; metering then credits
// the beneficiary's balance.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const purchase = defineContract({
  service: 'billing', name: 'purchase', method: 'POST', path: '/v1/purchases', callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    kind: z.enum(['tokens', 'simulations']),
    /** Tokens in hundreds (100 to 100,000); simulations one at a time (1 to 1,000). */
    quantity: z.number().int().min(1).max(100_000),
    /** Whose balance receives them. Default: the purchaser. */
    beneficiaryMembershipId: z.uuid().optional(),
  }),
  response: z.object({
    purchaseId: z.uuid(),
    kind: z.enum(['tokens', 'simulations']),
    quantity: z.number().int(),
    amount: z.string(),
    currency: z.string(),
  }),
  status: 201,
  maxBodyBytes: 512,
});

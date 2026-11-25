// Crediting a purchase (spec 73.4, 73.8). Billing takes the payment through the payment
// provider, then asks metering to record the purchase and credit the beneficiary's balance
// in one transaction. Purchased tokens and simulations never expire.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { units } from './charge.contract.ts';

export const creditPurchase = defineContract({
  service: 'metering', name: 'creditPurchase', method: 'POST', path: '/v1/purchases', callers: ['billing'],
  // Safe to repeat: the purchase id is the row's key, so a retry credits nothing more.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    purchaseId: z.uuid(),
    kind: z.enum(['tokens', 'simulations']),
    quantity: z.number().int().min(1).max(1_000_000),
    /** Major units, two decimals. */
    amount: z.string().regex(/^\d{1,10}\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/).default('GBP'),
    purchasedBy: z.uuid(),
    beneficiaryMembershipId: z.uuid(),
    autoTopup: z.boolean().default(false),
    /** The provider's payment reference, for reconciliation. */
    providerInvoiceId: z.string().regex(/^[A-Za-z0-9_]{1,255}$/).optional(),
  }),
  response: z.object({
    purchaseId: z.uuid(),
    /** False when this purchase was credited before. */
    credited: z.boolean(),
    balance: z.object({ purchasedRemaining: z.number().int(), simulationsPurchasedRemaining: units }),
  }),
  status: 201,
  maxBodyBytes: 1024,
});

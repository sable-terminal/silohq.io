// Siloes at provider cost plus 10% (spec 74.1, 74.2): what a closed month's Silo storage,
// compute and egress came to, per Silo and store, under billing.view. Each line states the
// provider cost and the 10% apart: "a customer asking what they are paying for sees the
// provider cost and the 10%, not a blended rate."

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const period = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
/** Pounds, six decimals: provider cost is kept to the micro-pound. */
const micro = z.string().regex(/^\d{1,8}\.\d{6}$/);
/** Pounds, two decimals. */
const money = z.string().regex(/^\d{1,12}\.\d{2}$/);

export const siloChargeLine = z.object({
  siloId: z.uuid(),
  siloName: z.string(),
  store: z.enum(['postgres', 'gcs', 'bigquery', 'index']),
  meanBytesHeld: z.string().regex(/^\d+$/),
  bytesScanned: z.string().regex(/^\d+$/),
  bytesEgressed: z.string().regex(/^\d+$/),
  costStorage: micro,
  costCompute: micro,
  costEgress: micro,
  /** The storage cost the entitlement's included storage covers (74.2): not billed. */
  includedCost: micro,
  /** What the provider charged that is billed: storage less included, plus compute and egress. */
  providerCost: micro,
  /** 10% of the provider cost. */
  uplift: micro,
  /** Provider cost plus 10%, to the penny: the invoice line. */
  amount: money,
  invoiceState: z.enum(['pending', 'invoiced', 'not_billed']),
  invoiceId: z.uuid().nullable(),
});
export type SiloChargeLine = z.infer<typeof siloChargeLine>;

export const listSiloCharges = defineContract({
  service: 'billing', name: 'listSiloCharges', method: 'GET', path: '/v1/billing/silo-charges', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  /** The month; the latest charged when absent. */
  query: z.strictObject({ period: period.optional() }),
  response: z.object({
    period: period.nullable(),
    lines: z.array(siloChargeLine),
    totals: z.object({ providerCost: micro, uplift: micro, amount: money }),
  }),
});

// Reading the token ledger (spec 73.6): what a customer disputes against, under
// billing.view, and the engagement cost report (73.5).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { OPERATIONS, SOURCES, units } from './charge.contract.ts';

const transaction = z.object({
  id: z.string().regex(/^\d{1,19}$/),
  membershipId: z.uuid().nullable(),
  operation: z.enum(OPERATIONS),
  pool: z.enum(['tokens', 'simulations']),
  weight: units,
  source: z.enum(SOURCES),
  correlationId: z.uuid(),
  engagementId: z.uuid().nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
});

export const listLedger = defineContract({
  service: 'metering', name: 'listLedger', method: 'GET', path: '/v1/ledger', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    membershipId: z.uuid().optional(),
    /** The cursor from the previous page. */
    beforeOccurredAt: z.iso.datetime({ offset: true }).optional(),
    beforeId: z.string().regex(/^\d{1,19}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).refine((q) => (q.beforeOccurredAt === undefined) === (q.beforeId === undefined), {
    message: 'a cursor is beforeOccurredAt with beforeId', path: ['beforeId'],
  }),
  response: z.object({
    transactions: z.array(transaction),
    next: z.object({ beforeOccurredAt: z.iso.datetime({ offset: true }), beforeId: z.string() }).nullable(),
  }),
});

export const engagementCost = defineContract({
  service: 'metering', name: 'engagementCost', method: 'GET', path: '/v1/engagements/:engagementId/cost',
  callers: ['gateway', 'admin-portal'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ engagementId: z.uuid() }),
  response: z.object({
    engagementId: z.uuid(),
    lines: z.array(z.object({
      operation: z.enum(OPERATIONS), pool: z.enum(['tokens', 'simulations']), source: z.enum(SOURCES), units, charges: z.number().int(),
    })),
    tokensCharged: units,
    simulationsCharged: units,
    /** The underlying model cost where measured (73.5): the engagement's calls priced at their routes' prices, in pounds. */
    modelCost: z.object({
      calls: z.int().min(0),
      priced: z.int().min(0),
      amount: z.string().regex(/^\d+\.\d{8}$/),
      /** Every call was priced. */
      measured: z.boolean(),
    }),
  }),
});

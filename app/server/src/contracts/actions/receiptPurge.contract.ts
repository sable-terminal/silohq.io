// Receipt purge (spec 46.1, 48.2, 65.3, 70): receipts hold the prior and new values of the
// fields an Action wrote, under their own retention and purge. Purge removes the values and
// keeps the hash, the references and the counts: the receipt's document, the mutation's
// intent, diff and manifest values, the prior states, the read-back values, a revert's
// conflict values, and any webhook payload still waiting. A receipt past its retention is
// purged by the sweep; a person holding silo.purge asks for one receipt, or every receipt
// naming an object (an erasure), through the organisation's approval chain where one is
// configured, as every wipe is (70.3). The Action ledger's values go with them (48.2).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const RECEIPT_PURGE_STATUSES = ['awaiting_approval', 'approved', 'rejected', 'running', 'completed', 'failed'] as const;

export const receiptPurgeView = z.object({
  id: z.uuid(),
  scope: z.enum(['receipt', 'object']),
  receiptId: z.uuid().nullable(),
  /** The Silo object whose receipts are purged: every receipt of a commit on it. */
  objectId: z.uuid().nullable(),
  status: z.enum(RECEIPT_PURGE_STATUSES),
  approvalChainId: z.uuid().nullable(),
  /** The hash an approver quotes: of the purge as asked. */
  documentHash: z.string().nullable(),
  requestedBy: z.uuid(),
  requestedAt: z.string(),
  /** The receipts reached, before it runs; those purged, after. */
  receipts: z.int(),
  /** Values cleared from the Action ledger's rows, where the ledger holds them. */
  ledgerRows: z.int().nullable(),
  completedAt: z.string().nullable(),
  failureStage: z.string().nullable(),
});
export type ReceiptPurgeView = z.infer<typeof receiptPurgeView>;

export const requestReceiptPurge = defineContract({
  service: 'actions', name: 'requestReceiptPurge', method: 'POST', path: '/v1/receipt-purges', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.discriminatedUnion('scope', [
    z.strictObject({ scope: z.literal('receipt'), receiptId: z.uuid() }),
    z.strictObject({ scope: z.literal('object'), objectId: z.uuid() }),
  ]),
  response: receiptPurgeView,
  status: 201,
  maxBodyBytes: 1024,
});

export const getReceiptPurge = defineContract({
  service: 'actions', name: 'getReceiptPurge', method: 'GET', path: '/v1/receipt-purges/:purgeId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ purgeId: z.uuid() }),
  response: receiptPurgeView,
});

/** The organisation's retention sweep run now (staff, as for Siloes): its receipts past their retention. */
export const runReceiptRetentionSweep = defineContract({
  service: 'actions', name: 'runReceiptRetentionSweep', method: 'POST', path: '/v1/receipt-retention-sweeps', callers: ['admin-portal'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ receipts: z.int(), ledgerRows: z.int() }),
});

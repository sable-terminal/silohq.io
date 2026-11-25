// The Action ledger in a Capture Silo (spec 48.2, 66.4; D205). Where the cell has no Warehouse,
// as in the sovereign cell, where "the ledger requires a configured UK-resident store", an
// organisation's Capture Silo holds it, in the cell's own Postgres:
//
// - The switch: a holder of silo.enable turns it on for one Capture Silo, with references only
//   or with values, having acknowledged its disclosure (invariant 8), or off. Off by default; one
//   Silo holds an organisation's ledger.
// - Written by actions after each receipt exists, one row per object; values sealed to the row,
//   and only with the values option. The receipt remains the record.
// - Receipt purge clears the values of its receipts' rows; references and outcomes stay. The
//   Silo's retention reaches the rows, and purging the Silo removes them (70).
// - Read through the reader's own access: a row whose markings or object type the reader does
//   not hold is withheld, and only counted.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { ACTION_LEDGER_MODES, ledgerRow } from '../warehouse/warehouse.contract.ts';

const id = z.uuid();
const siloParams = z.strictObject({ siloId: id });

export const setCaptureActionLedger = defineContract({
  service: 'siloes-capture', name: 'setCaptureActionLedger', method: 'POST', path: '/v1/siloes/:siloId/action-ledger',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.strictObject({
    mode: z.enum(ACTION_LEDGER_MODES),
    /** The person has read the disclosure shown for the ledger. */
    disclosureAcknowledged: z.boolean().default(false),
  }),
  response: z.object({ siloId: id, mode: z.enum(ACTION_LEDGER_MODES), disclosure: z.string() }),
});

/** The rows of one executed Action (actions, after its receipt). Values are kept only where the ledger holds them. */
export const writeCaptureLedger = defineContract({
  service: 'siloes-capture', name: 'writeCaptureLedger', method: 'POST', path: '/v1/action-ledger/rows',
  callers: ['actions'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({ receiptId: id, rows: z.array(ledgerRow).min(1).max(10_000) }),
  response: z.object({ written: z.int().min(0), mode: z.enum(ACTION_LEDGER_MODES) }),
  maxBodyBytes: 32 * 1024 * 1024,
});

/** Receipt purge reaches the ledger (48.2): the values of these receipts' rows are cleared. */
export const purgeCaptureLedgerValues = defineContract({
  service: 'siloes-capture', name: 'purgeCaptureLedgerValues', method: 'POST', path: '/v1/action-ledger/value-purges',
  callers: ['actions'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({ receiptIds: z.array(id).min(1).max(1_000) }),
  response: z.object({ rows: z.int().min(0) }),
  maxBodyBytes: 64 * 1024,
});

export const captureLedgerRow = ledgerRow.extend({
  /** Present only where values were kept and not since cleared by a receipt purge. */
  valuesClearedAt: z.string().nullable(),
  recordedAt: z.string(),
});
export type CaptureLedgerRow = z.infer<typeof captureLedgerRow>;

export const listCaptureLedger = defineContract({
  service: 'siloes-capture', name: 'listCaptureLedger', method: 'GET', path: '/v1/siloes/:siloId/action-ledger',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: siloParams,
  query: z.strictObject({
    receiptId: id.optional(),
    objectId: id.optional(),
    /** The previous page's next. */
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({
    mode: z.enum(ACTION_LEDGER_MODES),
    rows: z.array(captureLedgerRow),
    /** Rows on this page whose markings or object type the reader does not hold. */
    withheld: z.int().min(0),
    next: z.string().nullable(),
  }),
});

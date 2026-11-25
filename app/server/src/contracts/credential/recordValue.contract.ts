// Record values at rest (design doc conventions, "Record values"; spec 61): the columns
// that hold a customer's record values in Postgres (prior states, diffs, receipts,
// verifications, revert conflicts, mutation intents and values, and the like) are bytea,
// AES-256-GCM under the organisation's data key, which is wrapped by the cell KEK and
// reached only through the credential service (iam.organisation_keys.dek_wrapped is
// readable by silo_credential alone).
//
// The credential service seals and opens these values for the services that own the
// columns. A value is bound to its row: the binding (the table and the row's natural key)
// is the associated data, so a ciphertext copied to another row or tenant fails to open.
//
// Envelope (one bytea, no key column): format version (1 byte, 0x01), data key version
// (4 bytes, big endian), nonce (12 bytes), ciphertext, GCM tag (16 bytes).
//
// Values cross this boundary as base64 and are never logged; the bodies carry record
// values and are bounded by maxBodyBytes.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/**
 * The services that write record-value columns, added when they start writing one; org-export,
 * which opens them for the organisation's own exit export (spec 2.6); and notify, which opens
 * the webhook payloads actions queued, to post them (20.4).
 */
export const RECORD_VALUE_CALLERS = [
  'actions', 'approvals', 'revert', 'compile', 'ask', 'scheduler', 'siloes-capture', 'siloes-import', 'simulation', 'org-export', 'notify',
  // workspace: a trained model (D240), whose encoder holds the categories it learnt.
  'workspace',
] as const;

/** The table and the row's natural key, as strings: the associated data. */
export const valueBinding = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.string().min(1).max(500))
  .refine((b) => typeof b['table'] === 'string' && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(b['table']), 'names its schema-qualified table')
  .refine((b) => Object.keys(b).length <= 12, 'at most 12 binding columns');
export type ValueBinding = z.infer<typeof valueBinding>;

const base64 = z.string().max(16 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64');
const MAX_ITEMS = 5_000;

export const sealRecordValues = defineContract({
  service: 'credential', name: 'sealRecordValues', method: 'POST', path: '/v1/record-values/seal',
  callers: RECORD_VALUE_CALLERS,
  // Sealing again gives a new nonce; nothing is stored here.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ items: z.array(z.strictObject({ binding: valueBinding, value: base64 })).min(1).max(MAX_ITEMS) }),
  response: z.object({ items: z.array(base64) }),
  maxBodyBytes: 24 * 1024 * 1024,
});

export const openRecordValues = defineContract({
  service: 'credential', name: 'openRecordValues', method: 'POST', path: '/v1/record-values/open',
  callers: RECORD_VALUE_CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ items: z.array(z.strictObject({ binding: valueBinding, sealed: base64 })).min(1).max(MAX_ITEMS) }),
  response: z.object({ items: z.array(base64) }),
  maxBodyBytes: 24 * 1024 * 1024,
});

// connect-runtime: field profiles (spec 22.3). What each column of one source object looks
// like, as counts: rows examined, distinct, nulls, empty strings, shortest and longest text,
// and how many values parse as the field's declared type. Values are read into this
// service only, counted and dropped; nothing leaves but counts.
//
// The read is bounded (at most `maxRows`). A distinct count is exact or absent: given only
// when every row of the object was examined, never estimated from part of it. Minimum and
// maximum values and the most frequent values are never computed, because they are values.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const fieldProfileCounts = z.object({
  field: name,
  rowCount: z.int().min(0),
  /** Exact, or null when the object has more rows than were examined. */
  distinctCount: z.int().min(0).nullable(),
  nullCount: z.int().min(0),
  emptyCount: z.int().min(0),
  minLength: z.int().min(0).nullable(),
  maxLength: z.int().min(0).nullable(),
  typeConformanceCount: z.int().min(0),
});
export type FieldProfileCounts = z.infer<typeof fieldProfileCounts>;

export const profileObject = defineContract({
  service: 'connect-runtime', name: 'profileObject', method: 'POST', path: '/v1/profiles', callers: ['ontology'],
  // A profile reads and changes nothing at the source.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    object: name,
    /** The fields to profile; every declared field when absent. */
    fields: z.array(name).min(1).max(500).optional(),
    /** Probe while the connection is being built; query once it is active. */
    reason: z.enum(['query', 'probe']),
    maxRows: z.int().min(1).max(100_000).default(10_000),
  }),
  response: z.object({
    object: name,
    rowsExamined: z.int().min(0),
    /** Every row of the object was examined, so distinct counts are exact. */
    complete: z.boolean(),
    connectorVersion: z.string(),
    fields: z.array(fieldProfileCounts),
  }),
});

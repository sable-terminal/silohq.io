// Incremental Warehouse writes (spec 69.15): after the backfill, the changes a change stream
// observes for a nominated type reach the Warehouse through the same queue as Capture's
// (siloes-capture drains each Silo's queue). Each changed property updates the current row
// and adds a history row, found as a full sync finds it: by comparing hashes of Silo's
// canonical values. An object not yet in the Warehouse gets a row of what was observed; the
// next scheduled sync fills the rest. Values are record values in flight: never logged.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const warehouseObservation = z.strictObject({
  objectTypeId: z.uuid(),
  objectRef: z.string().min(1).max(500),
  property: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  value: z.json(),
  observedAt: z.iso.datetime({ offset: true }),
  connectionId: z.uuid(),
});
export type WarehouseObservation = z.infer<typeof warehouseObservation>;

export const applyWarehouseObservations = defineContract({
  service: 'warehouse-sync', name: 'applyWarehouseObservations', method: 'POST', path: '/v1/warehouse-observations', callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ siloId: z.uuid(), entries: z.array(warehouseObservation).min(1).max(5_000) }),
  response: z.object({
    /** Objects whose current row changed. */
    applied: z.int(),
    history: z.int(),
    /** Entries for a type or property the Warehouse no longer holds, or after it left Silo. */
    skipped: z.int(),
  }),
  maxBodyBytes: 8 * 1024 * 1024,
});

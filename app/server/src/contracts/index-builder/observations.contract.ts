// Object Index refresh from change streams (spec 69.4): each change to a nominated property
// of an indexed type, through the same queue Capture uses, updates the entry's value. The
// entry's markings stand as the last refresh set them, and its row hash is cleared, so the
// next scheduled refresh rewrites it in full; an object not yet indexed waits for that
// refresh, which alone computes an entry's markings. Values are record values in flight.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { warehouseObservation } from '../warehouse/observations.contract.ts';

export const applyIndexObservations = defineContract({
  service: 'index-builder', name: 'applyIndexObservations', method: 'POST', path: '/v1/index-observations', callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ siloId: z.uuid(), entries: z.array(warehouseObservation).min(1).max(5_000) }),
  response: z.object({ updated: z.int(), skipped: z.int() }),
  maxBodyBytes: 8 * 1024 * 1024,
});

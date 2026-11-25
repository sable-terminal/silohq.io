// Warehouse retention (spec 69.14, 70.1): the history tables keep changes observed within the
// Silo's window; a removed property's column is kept until the window has passed since its
// removal, then dropped with its values. Run by the retention sweep (siloes-capture).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const sweepWarehouse = defineContract({
  service: 'warehouse-schema', name: 'sweepWarehouse', method: 'POST', path: '/v1/warehouses/silos/:siloId/retention-sweeps', callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloId: z.uuid() }),
  body: z.strictObject({ before: z.iso.datetime({ offset: true }) }),
  response: z.object({ historyRows: z.int(), columnsDropped: z.int() }),
});

// BigQuery metering (spec 69.7, 69.19, 74.1; catalogue: bigquery-metering): bytes held and
// bytes billed per Silo held in Silo's BigQuery, priced at the cell region's provider rates
// and recorded as storage_measured, which metering writes to billing.storage_measurements.
// Billing adds the margin and shows the provider cost on each line.
//
// Measurements are of fixed windows (one metering interval, aligned to the epoch): each is
// keyed by its end, so a window is measured once however often the pass runs. A pass
// measures every completed window since the Silo's last measurement (at most 31).
// An operator may run the pass for one organisation now (admin-portal).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const measurementView = z.object({
  measurementId: z.uuid(),
  siloId: z.uuid(),
  kind: z.enum(['capture', 'import', 'object_index', 'warehouse']),
  store: z.enum(['postgres', 'gcs', 'bigquery', 'index']),
  windowStart: z.string(),
  measuredAt: z.string(),
  bytesHeld: z.string(),
  bytesScanned: z.string(),
  costStorage: z.string(),
  costCompute: z.string(),
  providerCost: z.string(),
});
export type MeasurementView = z.infer<typeof measurementView>;

export const measureBigQuery = defineContract({
  service: 'bigquery-metering', name: 'measureBigQuery', method: 'POST', path: '/v1/measurements',
  callers: ['admin-portal'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ measurements: z.array(measurementView) }),
});

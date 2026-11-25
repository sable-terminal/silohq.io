// Usage messages on bus-durable topic metering.usage (spec 9.2), which metering consumes.
//
// storage_measured: bytes held, scanned and egressed per Silo and store, with the provider
// cost at the actual regional rate for the interval since the previous measurement (spec
// 67.6, 68.8, 69.7, 74.1). Siloes Capture, Siloes Import, the index builder and BigQuery
// metering write it to their outbox; metering records it in billing.storage_measurements
// from the first day a Silo exists. Counts and costs only, never a value.

import { z } from 'zod';

const bytes = z.string().regex(/^\d{1,19}$/);
const cost = z.string().regex(/^\d{1,8}(\.\d{1,6})?$/);

export const storageMeasuredMessage = {
  topic: 'metering.usage',
  name: 'storage_measured',
  version: 1,
  schema: z.strictObject({
    organisationId: z.uuid(),
    /** The producer's identifier for this measurement; the row keeps it. */
    measurementId: z.uuid(),
    siloId: z.uuid(),
    store: z.enum(['postgres', 'gcs', 'bigquery', 'index']),
    bytesHeld: bytes,
    bytesScanned: bytes.default('0'),
    bytesEgressed: bytes.default('0'),
    /** Equals costStorage + costCompute + costEgress, shown per line on the invoice (74.1). */
    providerCost: cost,
    costStorage: cost.default('0'),
    costCompute: cost.default('0'),
    costEgress: cost.default('0'),
    /** Billing period, YYYY-MM. */
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    measuredAt: z.iso.datetime({ offset: true }),
  }),
} as const;

export type StorageMeasured = z.infer<typeof storageMeasuredMessage.schema>;

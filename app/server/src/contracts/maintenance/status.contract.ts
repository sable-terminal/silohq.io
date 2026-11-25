// The maintenance service's status: when each job last ran and succeeded, whether it is
// behind (no success within two intervals), and every partitioned table that needs
// attention. Read by Fleet and the status page; no tenant data.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const timestamp = z.iso.datetime({ offset: true });

export const maintenanceStatus = defineContract({
  service: 'maintenance', name: 'maintenanceStatus', method: 'GET', path: '/v1/maintenance/status',
  callers: ['fleet-control', 'status', 'admin-portal'],
  context: 'none', idempotency: 'none',
  response: z.object({
    jobs: z.array(z.object({
      name: z.enum(['partitions', 'seals', 'retention', 'sweeps']),
      lastRunAt: timestamp.nullable(),
      lastSuccessAt: timestamp.nullable(),
      outcome: z.enum(['never', 'ok', 'failed']),
      behind: z.boolean(),
      counts: z.record(z.string(), z.number()),
    })),
    unhealthyPartitions: z.array(z.object({
      parent: z.string(),
      coveredUntil: timestamp.nullable(),
      requiredUntil: timestamp,
      defaultRows: z.number().int().nullable(),
    })),
  }),
});

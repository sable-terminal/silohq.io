// Runs every maintenance job at start and then every interval.

import type { Worker } from '../../infra/service.infra.ts';
import type { Maintenance } from '../../services/maintenance/maintenance.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function maintenanceWorker(maintenance: Maintenance, intervalMs: number): Worker {
  return {
    name: 'maintenance',
    async run(signal) {
      while (!signal.aborted) {
        await maintenance.runAll();
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}

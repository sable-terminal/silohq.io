// Scheduled Warehouse syncs (spec 69.15): at each interval, every active Warehouse re-reads
// its nominated types, acting as its own principal. A source without a change stream is
// kept current this way; incremental writes from change streams come with the capture path.

import type { Worker } from '../../infra/service.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { warehouseProjectRepo } from '../../repos/siloes/index.repo.ts';
import { startSync } from '../../services/warehouse-sync/sync.service.ts';
import type { WarehouseDeps } from '../../services/warehouse-schema/warehouse.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function scheduledSyncWorker(deps: WarehouseDeps): Worker {
  return {
    name: 'warehouse-scheduled-sync',
    async run(signal) {
      while (!signal.aborted) {
        await sleep(deps.config.syncIntervalSeconds * 1_000, signal).catch(() => undefined);
        if (signal.aborted) break;
        const due = await inTransaction(deps.databases.pool('control'), {}, (db) => warehouseProjectRepo.listActive(db, 500))
          .catch((error: unknown) => { deps.logger.failure('listing Warehouses to sync failed', error, { event: 'warehouse.schedule_failed' }); return []; });
        for (const w of due) {
          if (signal.aborted) break;
          const ctx = { request: { organisationId: w.organisationId, servicePrincipalId: w.servicePrincipalId }, correlationId: uuidv7() };
          await startSync(deps, ctx, w.id, 'scheduled').catch((error: unknown) => {
            deps.logger.failure('a scheduled Warehouse sync did not start', error, { event: 'warehouse.schedule_failed', organisationId: w.organisationId });
          });
        }
      }
    },
  };
}

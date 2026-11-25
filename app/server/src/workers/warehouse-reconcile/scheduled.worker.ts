// Scheduled reconciliation (spec 69.15): at each interval, every active Warehouse compares
// its tables with their sources, acting as its own principal, and resyncs drift.

import type { Worker } from '../../infra/service.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { warehouseProjectRepo } from '../../repos/siloes/index.repo.ts';
import { reconcile } from '../../services/warehouse-reconcile/reconcile.service.ts';
import type { WarehouseDeps } from '../../services/warehouse-schema/warehouse.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function scheduledReconcileWorker(deps: WarehouseDeps): Worker {
  return {
    name: 'warehouse-scheduled-reconcile',
    async run(signal) {
      while (!signal.aborted) {
        await sleep(deps.config.reconcileIntervalSeconds * 1_000, signal).catch(() => undefined);
        if (signal.aborted) break;
        const due = await inTransaction(deps.databases.pool('control'), {}, (db) => warehouseProjectRepo.listActive(db, 500))
          .catch((error: unknown) => { deps.logger.failure('listing Warehouses to reconcile failed', error, { event: 'warehouse.schedule_failed' }); return []; });
        for (const w of due) {
          if (signal.aborted) break;
          const ctx = { request: { organisationId: w.organisationId, servicePrincipalId: w.servicePrincipalId }, correlationId: uuidv7() };
          await reconcile(deps, ctx, w.id, false).catch((error: unknown) => {
            deps.logger.failure('a scheduled reconciliation failed', error, { event: 'warehouse.reconcile_failed', organisationId: w.organisationId });
          });
        }
      }
    },
  };
}

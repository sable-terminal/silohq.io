// warehouse-reconcile (spec 69.15): row counts and a sample of keys against the sources, on
// a schedule and on request; drift is resynced, an unreachable source marks the table stale.

import { reconcileWarehouse } from '../../contracts/warehouse/warehouse.contract.ts';
import { reconcileController } from '../../controllers/warehouse-reconcile/reconcile.controller.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { bigQueryFrom } from '../../services/warehouse-schema/warehouse.service.ts';
import { scheduledReconcileWorker } from '../../workers/warehouse-reconcile/scheduled.worker.ts';

export function createWarehouseReconcileService(options: { bigQuery?: BigQueryAdapter; schedule?: boolean } = {}) {
  return defineService({
    name: 'warehouse-reconcile',
    needs: { postgres: ['control'] },
    create(deps) {
      const bigQuery = options.bigQuery ?? bigQueryFrom(deps.config);
      const shared = { databases: deps.databases, services: deps.services, logger: deps.logger, bigQuery, config: deps.config.warehouse };
      const c = reconcileController(shared);
      return {
        routes: [route(reconcileWarehouse, c.reconcileWarehouse)],
        workers: options.schedule === false ? [] : [scheduledReconcileWorker(shared)],
        close: async () => { if (options.bigQuery === undefined) await bigQuery.close(); },
      };
    },
  });
}

export const service = createWarehouseReconcileService();

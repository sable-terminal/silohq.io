// warehouse-sync (spec 69.15): backfill, scheduled and reconciliation syncs, reading through
// the federated engine as the Warehouse's principal.

import { applyWarehouseObservations } from '../../contracts/warehouse/observations.contract.ts';
import { purgeActionLedgerValues, syncWarehouse, writeActionLedger } from '../../contracts/warehouse/warehouse.contract.ts';
import { syncController } from '../../controllers/warehouse-sync/sync.controller.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { bigQueryFrom } from '../../services/warehouse-schema/warehouse.service.ts';
import { scheduledSyncWorker } from '../../workers/warehouse-sync/scheduled.worker.ts';

export function createWarehouseSyncService(options: { bigQuery?: BigQueryAdapter; schedule?: boolean } = {}) {
  return defineService({
    name: 'warehouse-sync',
    needs: { postgres: ['control'] },
    create(deps) {
      const bigQuery = options.bigQuery ?? bigQueryFrom(deps.config);
      const shared = { databases: deps.databases, services: deps.services, logger: deps.logger, bigQuery, config: deps.config.warehouse };
      const c = syncController(shared);
      return {
        routes: [
          route(syncWarehouse, c.syncWarehouse), route(writeActionLedger, c.writeActionLedger), route(purgeActionLedgerValues, c.purgeActionLedgerValues),
          // Change streams between syncs, from the Siloes' observation queue (69.15).
          route(applyWarehouseObservations, c.applyWarehouseObservations),
        ],
        workers: options.schedule === false ? [] : [scheduledSyncWorker(shared)],
        close: async () => { if (options.bigQuery === undefined) await bigQuery.close(); },
      };
    },
  });
}

export const service = createWarehouseSyncService();

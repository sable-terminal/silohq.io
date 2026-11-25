// warehouse-access (spec 69.16, 69.17, 69.20): direct SQL for a customer's analysts, never
// where marked data is held, and the Warehouse's exit by hand-over or Parquet export.

import {
  exportWarehouse, grantWarehouseSqlAccess, handOverWarehouse, listWarehouseSqlGrants, purgeWarehouse, purgeWarehouseType, revokeWarehouseSqlAccess,
} from '../../contracts/warehouse/access.contract.ts';
import { accessController } from '../../controllers/warehouse-access/access.controller.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { createObjectStore, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { bigQueryFrom } from '../../services/warehouse-schema/warehouse.service.ts';
import { markingsWorker } from '../../workers/warehouse-access/markings.worker.ts';

export function createWarehouseAccessService(options: { bigQuery?: BigQueryAdapter; store?: ObjectStore; filesBucket?: string; schedule?: boolean } = {}) {
  return defineService({
    name: 'warehouse-access',
    needs: { postgres: ['control'] },
    async create(deps) {
      const bigQuery = options.bigQuery ?? bigQueryFrom(deps.config);
      const storage = deps.config.objectStorage;
      const store = options.store ?? (storage?.filesBucket === undefined ? undefined : await createObjectStore(storage));
      const shared = {
        databases: deps.databases, services: deps.services, logger: deps.logger, bigQuery, config: deps.config.warehouse, store,
        filesBucket: options.filesBucket ?? storage?.filesBucket,
      };
      const c = accessController(shared);
      return {
        routes: [
          route(grantWarehouseSqlAccess, c.grantWarehouseSqlAccess), route(revokeWarehouseSqlAccess, c.revokeWarehouseSqlAccess),
          route(listWarehouseSqlGrants, c.listWarehouseSqlGrants), route(handOverWarehouse, c.handOverWarehouse), route(exportWarehouse, c.exportWarehouse),
          route(purgeWarehouse, c.purgeWarehouse), route(purgeWarehouseType, c.purgeWarehouseType),
        ],
        workers: options.schedule === false ? [] : [markingsWorker(shared)],
        close: async () => { if (options.bigQuery === undefined) await bigQuery.close(); },
      };
    },
  });
}

export const service = createWarehouseAccessService();

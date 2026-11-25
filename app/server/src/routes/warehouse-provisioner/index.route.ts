// warehouse-provisioner (spec 69.13): "Create warehouse" and the recorded, retryable steps
// that build it. Refused in the sovereign build, where BigQuery is not (config: spec 69.18).

import { createWarehouse, getWarehouse, retryWarehouseProvisioning, adoptWarehouse, releaseWarehouse } from '../../contracts/warehouse/warehouse.contract.ts';
import { warehouseController } from '../../controllers/warehouse-provisioner/warehouse.controller.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { bigQueryFrom } from '../../services/warehouse-schema/warehouse.service.ts';

export function createWarehouseProvisionerService(options: { bigQuery?: BigQueryAdapter } = {}) {
  return defineService({
    name: 'warehouse-provisioner',
    // redis-data: the idempotency keys of "Create warehouse".
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const bigQuery = options.bigQuery ?? bigQueryFrom(deps.config);
      const c = warehouseController({
        databases: deps.databases, services: deps.services, logger: deps.logger, bigQuery, config: deps.config.warehouse,
        cellId: deps.config.cell.id, keyProjectId: deps.config.bigQuery?.projectId ?? 'unset',
      });
      return {
        routes: [route(createWarehouse, c.createWarehouse), route(getWarehouse, c.getWarehouse), route(retryWarehouseProvisioning, c.retryWarehouseProvisioning),
          route(adoptWarehouse, c.adoptWarehouse), route(releaseWarehouse, c.releaseWarehouse)],
        close: async () => { if (options.bigQuery === undefined) await bigQuery.close(); },
      };
    },
  });
}

export const service = createWarehouseProvisionerService();

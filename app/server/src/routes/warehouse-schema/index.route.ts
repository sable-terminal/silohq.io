// warehouse-schema (spec 69.14): the Warehouse's tables, following the ontology, through the
// warehouse generator (the only place its SQL is written).

import { aggregateWarehouse, readWarehouseAsOf, readWarehouseHistory, warehouseCoverage } from '../../contracts/warehouse/read.contract.ts';
import { sweepWarehouse } from '../../contracts/warehouse/retention.contract.ts';
import { applyWarehouseSchema, setActionLedger } from '../../contracts/warehouse/warehouse.contract.ts';
import { schemaController } from '../../controllers/warehouse-schema/schema.controller.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { bigQueryFrom } from '../../services/warehouse-schema/warehouse.service.ts';

export function createWarehouseSchemaService(options: { bigQuery?: BigQueryAdapter } = {}) {
  return defineService({
    name: 'warehouse-schema',
    needs: { postgres: ['control'] },
    create(deps) {
      const bigQuery = options.bigQuery ?? bigQueryFrom(deps.config);
      const c = schemaController({ databases: deps.databases, services: deps.services, logger: deps.logger, bigQuery, config: deps.config.warehouse });
      return {
        routes: [route(applyWarehouseSchema, c.applyWarehouseSchema), route(setActionLedger, c.setActionLedger), route(sweepWarehouse, c.sweepWarehouse),
          route(warehouseCoverage, c.warehouseCoverage), route(readWarehouseAsOf, c.readWarehouseAsOf), route(readWarehouseHistory, c.readWarehouseHistory),
          route(aggregateWarehouse, c.aggregateWarehouse)],
        close: async () => { if (options.bigQuery === undefined) await bigQuery.close(); },
      };
    },
  });
}

export const service = createWarehouseSchemaService();

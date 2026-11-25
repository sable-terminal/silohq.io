// The Warehouse schema endpoint: thin, over services/warehouse-schema.

import type { aggregateWarehouse, readWarehouseAsOf, readWarehouseHistory, warehouseCoverage } from '../../contracts/warehouse/read.contract.ts';
import type { sweepWarehouse } from '../../contracts/warehouse/retention.contract.ts';
import type { applyWarehouseSchema, setActionLedger } from '../../contracts/warehouse/warehouse.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { setActionLedger as switchLedger } from '../../services/warehouse-schema/ledger.service.ts';
import {
  aggregateWarehouse as aggregate, readWarehouseAsOf as readAsOf, readWarehouseHistory as readHistory, warehouseCoverage as coverage,
} from '../../services/warehouse-schema/read.service.ts';
import { sweepWarehouse as sweep } from '../../services/warehouse-schema/retention.service.ts';
import { applySchema } from '../../services/warehouse-schema/schema.service.ts';
import type { WarehouseDeps } from '../../services/warehouse-schema/warehouse.service.ts';

export function schemaController(deps: WarehouseDeps): {
  applyWarehouseSchema: RouteHandlers<typeof applyWarehouseSchema>; setActionLedger: RouteHandlers<typeof setActionLedger>;
  sweepWarehouse: RouteHandlers<typeof sweepWarehouse>;
  warehouseCoverage: RouteHandlers<typeof warehouseCoverage>; readWarehouseAsOf: RouteHandlers<typeof readWarehouseAsOf>;
  aggregateWarehouse: RouteHandlers<typeof aggregateWarehouse>; readWarehouseHistory: RouteHandlers<typeof readWarehouseHistory>;
} {
  return {
    applyWarehouseSchema: { handle: (input, ctx) => applySchema(deps, ctx, input.params.warehouseId) },
    sweepWarehouse: { handle: (input, ctx) => sweep(deps, ctx, input.params.siloId, input.body.before) },
    setActionLedger: { handle: (input, ctx) => switchLedger(deps, ctx, input.params.warehouseId, input.body.mode, input.body.disclosureAcknowledged) },
    warehouseCoverage: { handle: (input, ctx) => coverage(deps, ctx, input.body.objectTypeIds, input.body.linkTypeIds ?? []) },
    readWarehouseAsOf: { handle: (input, ctx) => readAsOf(deps, ctx, input.body) as never },
    aggregateWarehouse: { handle: (input, ctx) => aggregate(deps, ctx, input.body) as never },
    readWarehouseHistory: { handle: (input, ctx) => readHistory(deps, ctx, input.body) as never },
  };
}

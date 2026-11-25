// The Warehouse reconciliation endpoint: thin, over services/warehouse-reconcile.

import type { reconcileWarehouse } from '../../contracts/warehouse/warehouse.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { reconcile } from '../../services/warehouse-reconcile/reconcile.service.ts';
import type { WarehouseDeps } from '../../services/warehouse-schema/warehouse.service.ts';

export function reconcileController(deps: WarehouseDeps): { reconcileWarehouse: RouteHandlers<typeof reconcileWarehouse> } {
  return { reconcileWarehouse: { handle: (input, ctx) => reconcile(deps, ctx, input.params.warehouseId, true) } };
}

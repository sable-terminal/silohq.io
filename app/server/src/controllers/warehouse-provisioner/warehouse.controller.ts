// The Warehouse's provisioning endpoints: thin, over services/warehouse-provisioner.

import type { adoptWarehouse, createWarehouse, getWarehouse, releaseWarehouse, retryWarehouseProvisioning } from '../../contracts/warehouse/warehouse.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { warehouseProjectRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import * as provisioner from '../../services/warehouse-provisioner/provisioner.service.ts';
import { loadView } from '../../services/warehouse-schema/warehouse.service.ts';

export function warehouseController(deps: provisioner.ProvisionerDeps): {
  createWarehouse: RouteHandlers<typeof createWarehouse>;
  getWarehouse: RouteHandlers<typeof getWarehouse>;
  retryWarehouseProvisioning: RouteHandlers<typeof retryWarehouseProvisioning>;
  adoptWarehouse: RouteHandlers<typeof adoptWarehouse>;
  releaseWarehouse: RouteHandlers<typeof releaseWarehouse>;
} {
  return {
    createWarehouse: {
      handle: (input, ctx) => provisioner.createWarehouse(deps, ctx, input.body),
      resultRef: (out) => out.id,
      // A retried create answers with the Warehouse it made, as it stands now.
      replay: async (ref, ctx) => {
        const project = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => warehouseProjectRepo.findById(db, ref!), { readOnly: true });
        if (project === undefined) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
        return loadView(deps, ctx.request, project);
      },
    },
    getWarehouse: { handle: (_input, ctx) => provisioner.getWarehouse(deps, ctx) },
    retryWarehouseProvisioning: { handle: (input, ctx) => provisioner.retryProvisioning(deps, ctx, input.params.warehouseId) },
    adoptWarehouse: { handle: (input, ctx) => provisioner.adoptWarehouse(deps, ctx, input.params.warehouseId) },
    releaseWarehouse: { handle: (input, ctx) => provisioner.releaseWarehouse(deps, ctx, input.params.warehouseId) },
  };
}

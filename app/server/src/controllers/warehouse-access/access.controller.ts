// The Warehouse access and exit endpoints: thin, over services/warehouse-access.

import type {
  exportWarehouse, grantWarehouseSqlAccess, handOverWarehouse, listWarehouseSqlGrants, purgeWarehouse, purgeWarehouseType, revokeWarehouseSqlAccess,
} from '../../contracts/warehouse/access.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as access from '../../services/warehouse-access/access.service.ts';

export function accessController(deps: access.AccessDeps): {
  grantWarehouseSqlAccess: RouteHandlers<typeof grantWarehouseSqlAccess>;
  revokeWarehouseSqlAccess: RouteHandlers<typeof revokeWarehouseSqlAccess>;
  listWarehouseSqlGrants: RouteHandlers<typeof listWarehouseSqlGrants>;
  handOverWarehouse: RouteHandlers<typeof handOverWarehouse>;
  exportWarehouse: RouteHandlers<typeof exportWarehouse>;
  purgeWarehouse: RouteHandlers<typeof purgeWarehouse>;
  purgeWarehouseType: RouteHandlers<typeof purgeWarehouseType>;
} {
  return {
    grantWarehouseSqlAccess: { handle: (input, ctx) => access.grantSqlAccess(deps, ctx, input.params.warehouseId, input.body.googleIdentity) },
    revokeWarehouseSqlAccess: { handle: (input, ctx) => access.revokeSqlAccess(deps, ctx, input.params.warehouseId, input.params.grantId) },
    listWarehouseSqlGrants: { handle: (input, ctx) => access.listSqlGrants(deps, ctx, input.params.warehouseId) },
    handOverWarehouse: { handle: (input, ctx) => access.handOver(deps, ctx, input.params.warehouseId, input.body.destination) },
    exportWarehouse: { handle: (input, ctx) => access.exportTables(deps, ctx, input.params.warehouseId) },
    purgeWarehouse: { handle: (input, ctx) => access.purgeWarehouse(deps, ctx, input.params.warehouseId) },
    purgeWarehouseType: { handle: (input, ctx) => access.purgeWarehouseType(deps, ctx, input.params.warehouseId, input.params.objectTypeId) },
  };
}

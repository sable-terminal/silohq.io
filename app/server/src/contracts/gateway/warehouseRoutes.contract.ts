// The Warehouse in the product (spec 69.12 to 69.20): "Create warehouse" on the Siloes page
// (silo.create; keyed, so a retried create makes one Warehouse), its state, retrying a
// failed provisioning, and asking for a sync or a reconciliation (silo.manage); direct SQL
// grants (warehouse.sql_access, super admin only), hand-over (silo.purge) and the Parquet
// export (silo.manage).

import * as a from '../warehouse/access.contract.ts';
import * as w from '../warehouse/warehouse.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const manage = { permission: 'silo.manage' };

export const createWarehouseRoute = definePublicRoute({
  name: 'createWarehouse', method: 'POST', path: '/warehouses', session: 'complete', permission: { permission: 'silo.create' },
  body: w.createWarehouse.body, response: w.createWarehouse.response, status: 202, forwards: w.createWarehouse,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const getWarehouseRoute = definePublicRoute({
  name: 'getWarehouse', method: 'GET', path: '/warehouses/current', session: 'complete', permission: manage,
  response: w.getWarehouse.response, forwards: w.getWarehouse, call: () => ({}), reply: (output) => output,
});

export const retryWarehouseRoute = definePublicRoute({
  name: 'retryWarehouseProvisioning', method: 'POST', path: '/warehouses/:warehouseId/retry', session: 'complete', permission: manage,
  params: w.retryWarehouseProvisioning.params, response: w.retryWarehouseProvisioning.response, status: 202, forwards: w.retryWarehouseProvisioning,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const syncWarehouseRoute = definePublicRoute({
  name: 'syncWarehouse', method: 'POST', path: '/warehouses/:warehouseId/syncs', session: 'complete', permission: manage,
  params: w.syncWarehouse.params, body: w.syncWarehouse.body, response: w.syncWarehouse.response, status: 202, forwards: w.syncWarehouse,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const reconcileWarehouseRoute = definePublicRoute({
  name: 'reconcileWarehouse', method: 'POST', path: '/warehouses/:warehouseId/reconciliations', session: 'complete', permission: manage,
  params: w.reconcileWarehouse.params, response: w.reconcileWarehouse.response, forwards: w.reconcileWarehouse,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

const sqlAccess = { permission: 'warehouse.sql_access' };

export const grantWarehouseSqlAccessRoute = definePublicRoute({
  name: 'grantWarehouseSqlAccess', method: 'POST', path: '/warehouses/:warehouseId/sql-grants', session: 'complete', permission: sqlAccess,
  params: a.grantWarehouseSqlAccess.params, body: a.grantWarehouseSqlAccess.body, response: a.grantWarehouseSqlAccess.response, status: 201,
  forwards: a.grantWarehouseSqlAccess, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const revokeWarehouseSqlAccessRoute = definePublicRoute({
  name: 'revokeWarehouseSqlAccess', method: 'POST', path: '/warehouses/:warehouseId/sql-grants/:grantId/revoke', session: 'complete',
  permission: sqlAccess, params: a.revokeWarehouseSqlAccess.params, response: a.revokeWarehouseSqlAccess.response,
  forwards: a.revokeWarehouseSqlAccess, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listWarehouseSqlGrantsRoute = definePublicRoute({
  name: 'listWarehouseSqlGrants', method: 'GET', path: '/warehouses/:warehouseId/sql-grants', session: 'complete', permission: sqlAccess,
  params: a.listWarehouseSqlGrants.params, response: a.listWarehouseSqlGrants.response, forwards: a.listWarehouseSqlGrants,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const handOverWarehouseRoute = definePublicRoute({
  name: 'handOverWarehouse', method: 'POST', path: '/warehouses/:warehouseId/hand-over', session: 'complete', permission: { permission: 'silo.purge' },
  params: a.handOverWarehouse.params, body: a.handOverWarehouse.body, response: a.handOverWarehouse.response, forwards: a.handOverWarehouse,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const exportWarehouseRoute = definePublicRoute({
  name: 'exportWarehouse', method: 'POST', path: '/warehouses/:warehouseId/exports', session: 'complete', permission: manage,
  params: a.exportWarehouse.params, response: a.exportWarehouse.response, status: 201, forwards: a.exportWarehouse,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** The Action ledger (48.2): a Silo enablement (66.4), so silo.enable. */
export const setActionLedgerRoute = definePublicRoute({
  name: 'setActionLedger', method: 'POST', path: '/warehouses/:warehouseId/action-ledger', session: 'complete', permission: { permission: 'silo.enable' },
  params: w.setActionLedger.params, body: w.setActionLedger.body, response: w.setActionLedger.response, forwards: w.setActionLedger,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const WAREHOUSE_ROUTES = [
  createWarehouseRoute, getWarehouseRoute, retryWarehouseRoute, syncWarehouseRoute, reconcileWarehouseRoute, grantWarehouseSqlAccessRoute,
  revokeWarehouseSqlAccessRoute, listWarehouseSqlGrantsRoute, handOverWarehouseRoute, exportWarehouseRoute, setActionLedgerRoute,
] as const;

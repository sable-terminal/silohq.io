// Data access for siloes.warehouse_projects, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  warehouseProjectTable,
  type NewWarehouseProject,
  type WarehouseProject,
  type WarehouseProjectChanges,
} from '../../models/siloes/warehouseProject.model.ts';

export const warehouseProjectRepo = {
  insert(db: Queryable, row: NewWarehouseProject): Promise<WarehouseProject> {
    return insertRow(db, warehouseProjectTable, row);
  },

  findById(db: Queryable, id: WarehouseProject['id']): Promise<WarehouseProject | undefined> {
    return findRow(db, warehouseProjectTable, { id });
  },

  findByGcpProjectId(
    db: Queryable,
    gcpProjectId: WarehouseProject['gcpProjectId'],
  ): Promise<WarehouseProject | undefined> {
    return findRow(db, warehouseProjectTable, { gcpProjectId });
  },

  findByOrganisationId(
    db: Queryable,
    organisationId: WarehouseProject['organisationId'],
  ): Promise<WarehouseProject | undefined> {
    return findRow(db, warehouseProjectTable, { organisationId });
  },

  update(
    db: Queryable,
    id: WarehouseProject['id'],
    changes: WarehouseProjectChanges,
  ): Promise<WarehouseProject | undefined> {
    return updateRow(db, warehouseProjectTable, { id }, changes);
  },

  /** Active Warehouses across organisations, for scheduled sync and reconciliation: identifiers only. */
  async listActive(db: Queryable, limit: number): Promise<{ organisationId: string; id: string; servicePrincipalId: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", id, service_principal_id as "servicePrincipalId" from siloes.active_warehouses($1)', [limit]);
    return rows as { organisationId: string; id: string; servicePrincipalId: string }[];
  },

  /** Backfill done: active, once. Concurrent finishes race here; only one moves it. */
  async activateIfBackfilling(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update siloes.warehouse_projects set status = 'active', version = version + 1 where id = $1 and status = 'backfilling'`, [id]);
    return (rowCount ?? 0) > 0;
  },
};

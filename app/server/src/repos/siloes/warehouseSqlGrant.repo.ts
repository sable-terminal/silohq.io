// Data access for siloes.warehouse_sql_grants, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  warehouseSqlGrantTable,
  type NewWarehouseSqlGrant,
  type WarehouseSqlGrant,
  type WarehouseSqlGrantChanges,
} from '../../models/siloes/warehouseSqlGrant.model.ts';

export const warehouseSqlGrantRepo = {
  insert(db: Queryable, row: NewWarehouseSqlGrant): Promise<WarehouseSqlGrant> {
    return insertRow(db, warehouseSqlGrantTable, row);
  },

  findById(db: Queryable, id: WarehouseSqlGrant['id']): Promise<WarehouseSqlGrant | undefined> {
    return findRow(db, warehouseSqlGrantTable, { id });
  },

  update(
    db: Queryable,
    id: WarehouseSqlGrant['id'],
    changes: WarehouseSqlGrantChanges,
  ): Promise<WarehouseSqlGrant | undefined> {
    return updateRow(db, warehouseSqlGrantTable, { id }, changes);
  },

  /** A Warehouse's grants, live ones first. */
  async listForProject(db: Queryable, warehouseProjectId: string, live: boolean): Promise<WarehouseSqlGrant[]> {
    const { rows } = await db.query(
      `select ${warehouseSqlGrantTable.select} from siloes.warehouse_sql_grants
       where warehouse_project_id = $1 and ($2::boolean is false or revoked_at is null)
       order by (revoked_at is null) desc, granted_at desc, id`, [warehouseProjectId, live]);
    return rows as WarehouseSqlGrant[];
  },

  /** The Warehouses with live grants, across the cell, for the marking check: identifiers only. */
  async projectsWithLiveGrants(db: Queryable, limit: number): Promise<{ organisationId: string; warehouseProjectId: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", warehouse_project_id as "warehouseProjectId" from siloes.warehouses_with_sql_grants($1)', [limit]);
    return rows as { organisationId: string; warehouseProjectId: string }[];
  },
};

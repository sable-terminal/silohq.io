// Data access for siloes.warehouse_tables, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  warehouseTableTable,
  type NewWarehouseTable,
  type WarehouseTable,
  type WarehouseTableChanges,
} from '../../models/siloes/warehouseTable.model.ts';

export const warehouseTableRepo = {
  insert(db: Queryable, row: NewWarehouseTable): Promise<WarehouseTable> {
    return insertRow(db, warehouseTableTable, row);
  },

  findById(db: Queryable, id: WarehouseTable['id']): Promise<WarehouseTable | undefined> {
    return findRow(db, warehouseTableTable, { id });
  },

  findByWarehouseProjectIdAndTableName(
    db: Queryable,
    key: Pick<WarehouseTable, 'organisationId' | 'warehouseProjectId' | 'tableName'>,
  ): Promise<WarehouseTable | undefined> {
    return findRow(db, warehouseTableTable, key);
  },

  update(
    db: Queryable,
    id: WarehouseTable['id'],
    changes: WarehouseTableChanges,
  ): Promise<WarehouseTable | undefined> {
    return updateRow(db, warehouseTableTable, { id }, changes);
  },

  /** A Warehouse's live tables, in name order. */
  async listForProject(db: Queryable, warehouseProjectId: string): Promise<WarehouseTable[]> {
    const { rows } = await db.query(
      `select ${warehouseTableTable.select} from siloes.warehouse_tables
       where warehouse_project_id = $1 and dropped_at is null order by table_name`, [warehouseProjectId]);
    return rows as WarehouseTable[];
  },
};

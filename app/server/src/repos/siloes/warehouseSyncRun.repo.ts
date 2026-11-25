// Data access for siloes.warehouse_sync_runs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  warehouseSyncRunTable,
  type NewWarehouseSyncRun,
  type WarehouseSyncRun,
  type WarehouseSyncRunChanges,
} from '../../models/siloes/warehouseSyncRun.model.ts';

export const warehouseSyncRunRepo = {
  insert(db: Queryable, row: NewWarehouseSyncRun): Promise<WarehouseSyncRun> {
    return insertRow(db, warehouseSyncRunTable, row);
  },

  findById(db: Queryable, id: WarehouseSyncRun['id']): Promise<WarehouseSyncRun | undefined> {
    return findRow(db, warehouseSyncRunTable, { id });
  },

  update(
    db: Queryable,
    id: WarehouseSyncRun['id'],
    changes: WarehouseSyncRunChanges,
  ): Promise<WarehouseSyncRun | undefined> {
    return updateRow(db, warehouseSyncRunTable, { id }, changes);
  },

  /** The last run of each of these tables: what freshness is judged from (spec 69.15). */
  async latestFor(db: Queryable, tableIds: readonly string[]): Promise<WarehouseSyncRun[]> {
    if (tableIds.length === 0) return [];
    const { rows } = await db.query(
      `select distinct on (warehouse_table_id) ${warehouseSyncRunTable.select} from siloes.warehouse_sync_runs
       where warehouse_table_id = any($1::uuid[]) order by warehouse_table_id, started_at desc, id desc`, [tableIds]);
    return rows as WarehouseSyncRun[];
  },
};

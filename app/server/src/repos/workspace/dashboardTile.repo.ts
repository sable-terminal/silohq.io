// Data access for workspace.dashboard_tiles, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  dashboardTileTable,
  type DashboardTile,
  type DashboardTileChanges,
  type NewDashboardTile,
} from '../../models/workspace/dashboardTile.model.ts';

export const dashboardTileRepo = {
  insert(db: Queryable, row: NewDashboardTile): Promise<DashboardTile> {
    return insertRow(db, dashboardTileTable, row);
  },

  findById(db: Queryable, id: DashboardTile['id']): Promise<DashboardTile | undefined> {
    return findRow(db, dashboardTileTable, { id });
  },

  update(
    db: Queryable,
    id: DashboardTile['id'],
    changes: DashboardTileChanges,
  ): Promise<DashboardTile | undefined> {
    return updateRow(db, dashboardTileTable, { id }, changes);
  },

  remove(db: Queryable, id: DashboardTile['id']): Promise<boolean> {
    return deleteRow(db, dashboardTileTable, { id });
  },

  async listForMember(db: Queryable, membershipId: string): Promise<DashboardTile[]> {
    const { rows } = await db.query(
      `select ${dashboardTileTable.select} from workspace.dashboard_tiles where membership_id = $1 order by grid[2], grid[1], created_at`,
      [membershipId]);
    return rows as DashboardTile[];
  },

  async findForView(db: Queryable, membershipId: string, viewId: string): Promise<DashboardTile | undefined> {
    const { rows } = await db.query(
      `select ${dashboardTileTable.select} from workspace.dashboard_tiles where membership_id = $1 and saved_view_id = $2`,
      [membershipId, viewId]);
    return rows[0] as DashboardTile | undefined;
  },

  /** Removes a view's tiles: one member's, or everyone's when no member is named. */
  async removeForView(db: Queryable, viewId: string, membershipId?: string): Promise<number> {
    const { rowCount } = await db.query(
      'delete from workspace.dashboard_tiles where saved_view_id = $1 and ($2::uuid is null or membership_id = $2)', [viewId, membershipId ?? null]);
    return rowCount ?? 0;
  },

  async findForCanvasView(db: Queryable, membershipId: string, canvasViewId: string): Promise<DashboardTile | undefined> {
    const { rows } = await db.query(
      `select ${dashboardTileTable.select} from workspace.dashboard_tiles where membership_id = $1 and canvas_view_id = $2`,
      [membershipId, canvasViewId]);
    return rows[0] as DashboardTile | undefined;
  },

  /** Removes a canvas view's tiles: one member's, or everyone's when no member is named. */
  async removeForCanvasView(db: Queryable, canvasViewId: string, membershipId?: string): Promise<number> {
    const { rowCount } = await db.query(
      'delete from workspace.dashboard_tiles where canvas_view_id = $1 and ($2::uuid is null or membership_id = $2)',
      [canvasViewId, membershipId ?? null]);
    return rowCount ?? 0;
  },
};

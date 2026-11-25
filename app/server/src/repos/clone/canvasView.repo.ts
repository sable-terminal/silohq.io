// Data access for clone.canvas_views, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  canvasViewTable,
  type CanvasView,
  type CanvasViewChanges,
  type NewCanvasView,
} from '../../models/clone/canvasView.model.ts';

export const canvasViewRepo = {
  insert(db: Queryable, row: NewCanvasView): Promise<CanvasView> {
    return insertRow(db, canvasViewTable, row);
  },

  findById(db: Queryable, id: CanvasView['id']): Promise<CanvasView | undefined> {
    return findRow(db, canvasViewTable, { id });
  },

  update(db: Queryable, id: CanvasView['id'], changes: CanvasViewChanges): Promise<CanvasView | undefined> {
    return updateRow(db, canvasViewTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<CanvasView | undefined> {
    const { rows } = await db.query(
      `select ${canvasViewTable.select} from clone.canvas_views where id = $1 and deleted_at is null for update`, [id]);
    return rows[0] as CanvasView | undefined;
  },

  /** A member's own views, newest first: live, favourited or archived. */
  async listOwned(db: Queryable, membershipId: string, filter: 'mine' | 'favourited' | 'archived', limit: number): Promise<CanvasView[]> {
    const { rows } = await db.query(
      `select ${canvasViewTable.select} from clone.canvas_views
       where owner_membership_id = $1 and deleted_at is null
         and case $2 when 'archived' then archived_at is not null
                     when 'favourited' then archived_at is null and favourited
                     else archived_at is null end
       order by updated_at desc, id limit $3`,
      [membershipId, filter, limit]);
    return rows as CanvasView[];
  },

  async findMany(db: Queryable, ids: readonly string[], limit: number): Promise<CanvasView[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${canvasViewTable.select} from clone.canvas_views
       where id = any($1::uuid[]) and deleted_at is null and archived_at is null order by updated_at desc, id limit $2`, [ids, limit]);
    return rows as CanvasView[];
  },
};

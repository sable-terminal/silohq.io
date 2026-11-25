// Data access for clone.view_preferences, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  viewPreferenceTable,
  type NewViewPreference,
  type ViewPreference,
  type ViewPreferenceChanges,
} from '../../models/clone/viewPreference.model.ts';

export const viewPreferenceRepo = {
  insert(db: Queryable, row: NewViewPreference): Promise<ViewPreference> {
    return insertRow(db, viewPreferenceTable, row);
  },

  findById(db: Queryable, id: ViewPreference['id']): Promise<ViewPreference | undefined> {
    return findRow(db, viewPreferenceTable, { id });
  },

  update(
    db: Queryable,
    id: ViewPreference['id'],
    changes: ViewPreferenceChanges,
  ): Promise<ViewPreference | undefined> {
    return updateRow(db, viewPreferenceTable, { id }, changes);
  },

  /** A member's preference for one saved view or canvas view, locked for change. */
  /** The member's preference for one view, without locking it: for reading. */
  async readFor(db: Queryable, membershipId: string, view: { savedViewId?: string; canvasViewId?: string }): Promise<ViewPreference | undefined> {
    const { rows } = await db.query(
      `select ${viewPreferenceTable.select} from clone.view_preferences
       where membership_id = $1 and saved_view_id is not distinct from $2 and canvas_view_id is not distinct from $3`,
      [membershipId, view.savedViewId ?? null, view.canvasViewId ?? null]);
    return rows[0] as ViewPreference | undefined;
  },

  async findFor(db: Queryable, membershipId: string, view: { savedViewId?: string; canvasViewId?: string }): Promise<ViewPreference | undefined> {
    const { rows } = await db.query(
      `select ${viewPreferenceTable.select} from clone.view_preferences
       where membership_id = $1 and saved_view_id is not distinct from $2 and canvas_view_id is not distinct from $3 for update`,
      [membershipId, view.savedViewId ?? null, view.canvasViewId ?? null]);
    return rows[0] as ViewPreference | undefined;
  },
};

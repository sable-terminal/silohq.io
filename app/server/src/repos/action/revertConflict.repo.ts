// Data access for action.revert_conflicts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  revertConflictTable,
  type NewRevertConflict,
  type RevertConflict,
  type RevertConflictChanges,
} from '../../models/action/revertConflict.model.ts';

export const revertConflictRepo = {
  insert(db: Queryable, row: NewRevertConflict): Promise<RevertConflict> {
    return insertRow(db, revertConflictTable, row);
  },

  findById(db: Queryable, id: RevertConflict['id']): Promise<RevertConflict | undefined> {
    return findRow(db, revertConflictTable, { id });
  },

  findByRevertIdAndObjectIdAndEntityReferenceAndField(
    db: Queryable,
    key: Pick<RevertConflict, 'organisationId' | 'revertId' | 'objectId' | 'entityReference' | 'field'>,
  ): Promise<RevertConflict | undefined> {
    return findRow(db, revertConflictTable, key);
  },

  update(
    db: Queryable,
    id: RevertConflict['id'],
    changes: RevertConflictChanges,
  ): Promise<RevertConflict | undefined> {
    return updateRow(db, revertConflictTable, { id }, changes);
  },

  async listByRevert(db: Queryable, revertId: string): Promise<RevertConflict[]> {
    const { rows } = await db.query(`select ${revertConflictTable.select} from action.revert_conflicts where revert_id = $1 order by created_at, id`, [revertId]);
    return rows as RevertConflict[];
  },
};

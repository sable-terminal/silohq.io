// Data access for clone.clone_layouts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  cloneLayoutTable,
  type CloneLayout,
  type CloneLayoutChanges,
  type NewCloneLayout,
} from '../../models/clone/cloneLayout.model.ts';

export const cloneLayoutRepo = {
  insert(db: Queryable, row: NewCloneLayout): Promise<CloneLayout> {
    return insertRow(db, cloneLayoutTable, row);
  },

  findById(db: Queryable, id: CloneLayout['id']): Promise<CloneLayout | undefined> {
    return findRow(db, cloneLayoutTable, { id });
  },

  update(
    db: Queryable,
    id: CloneLayout['id'],
    changes: CloneLayoutChanges,
  ): Promise<CloneLayout | undefined> {
    return updateRow(db, cloneLayoutTable, { id }, changes);
  },

  /** The live configuration of each type (clone_layouts_live). */
  async liveFor(db: Queryable, objectTypeIds: readonly string[]): Promise<CloneLayout[]> {
    if (objectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${cloneLayoutTable.select} from clone.clone_layouts
       where object_type_id = any($1::uuid[]) and superseded_at is null order by object_type_id`, [objectTypeIds]);
    return rows as CloneLayout[];
  },

  /** Supersedes the type's live row, returning whether there was one. */
  async supersedeLive(db: Queryable, objectTypeId: string, at: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'update clone.clone_layouts set superseded_at = $2 where object_type_id = $1 and superseded_at is null', [objectTypeId, at]);
    return (rowCount ?? 0) > 0;
  },
};

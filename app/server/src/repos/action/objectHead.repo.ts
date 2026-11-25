// Data access for action.object_heads, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  objectHeadTable,
  type NewObjectHead,
  type ObjectHead,
  type ObjectHeadChanges,
} from '../../models/action/objectHead.model.ts';

export const objectHeadRepo = {
  insert(db: Queryable, row: NewObjectHead): Promise<ObjectHead> {
    return insertRow(db, objectHeadTable, row);
  },

  findById(db: Queryable, id: ObjectHead['id']): Promise<ObjectHead | undefined> {
    return findRow(db, objectHeadTable, { id });
  },

  findByObjectId(
    db: Queryable,
    key: Pick<ObjectHead, 'organisationId' | 'objectId'>,
  ): Promise<ObjectHead | undefined> {
    return findRow(db, objectHeadTable, key);
  },

  update(db: Queryable, id: ObjectHead['id'], changes: ObjectHeadChanges): Promise<ObjectHead | undefined> {
    return updateRow(db, objectHeadTable, { id }, changes);
  },

  /** Locks the object's head, so commits on one object serialise (46.2). */
  async lockByObjectId(db: Queryable, objectId: string): Promise<ObjectHead | undefined> {
    const { rows } = await db.query(`select ${objectHeadTable.select} from action.object_heads where object_id = $1 for update`, [objectId]);
    return rows[0] as ObjectHead | undefined;
  },
};

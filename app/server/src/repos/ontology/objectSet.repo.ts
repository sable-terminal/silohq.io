// Data access for ontology.object_sets, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  objectSetTable,
  type NewObjectSet,
  type ObjectSet,
  type ObjectSetChanges,
} from '../../models/ontology/objectSet.model.ts';

export const objectSetRepo = {
  insert(db: Queryable, row: NewObjectSet): Promise<ObjectSet> {
    return insertRow(db, objectSetTable, row);
  },

  findById(db: Queryable, id: ObjectSet['id']): Promise<ObjectSet | undefined> {
    return findRow(db, objectSetTable, { id });
  },

  update(db: Queryable, id: ObjectSet['id'], changes: ObjectSetChanges): Promise<ObjectSet | undefined> {
    return updateRow(db, objectSetTable, { id }, changes);
  },

  /** Live sets the membership owns, and shared ones. */
  async listVisible(db: Queryable, membershipId: string, limit: number): Promise<ObjectSet[]> {
    const { rows } = await db.query(
      `select ${objectSetTable.select} from ontology.object_sets
        where archived_at is null and (owner_membership_id = $1 or visibility = 'shared')
        order by created_at desc limit $2`, [membershipId, limit]);
    return rows as ObjectSet[];
  },
};

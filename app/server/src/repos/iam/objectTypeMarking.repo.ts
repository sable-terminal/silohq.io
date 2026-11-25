// Data access for iam.object_type_markings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  objectTypeMarkingTable,
  type NewObjectTypeMarking,
  type ObjectTypeMarking,
  type ObjectTypeMarkingPrimaryKey,
} from '../../models/iam/objectTypeMarking.model.ts';

export const objectTypeMarkingRepo = {
  insert(db: Queryable, row: NewObjectTypeMarking): Promise<ObjectTypeMarking> {
    return insertRow(db, objectTypeMarkingTable, row);
  },

  findByKey(db: Queryable, key: ObjectTypeMarkingPrimaryKey): Promise<ObjectTypeMarking | undefined> {
    return findRow(db, objectTypeMarkingTable, key);
  },

  remove(db: Queryable, key: ObjectTypeMarkingPrimaryKey): Promise<boolean> {
    return deleteRow(db, objectTypeMarkingTable, key);
  },

  /** The direct markings on these object types (spec 57.7). */
  async markingsFor(db: Queryable, objectTypeIds: readonly string[]): Promise<{ resourceId: string; markingId: string }[]> {
    if (objectTypeIds.length === 0) return [];
    const { rows } = await db.query(
      `select object_type_id as "resourceId", marking_id as "markingId" from iam.object_type_markings
       where object_type_id = any($1::uuid[])`, [objectTypeIds]);
    return rows as { resourceId: string; markingId: string }[];
  },
};

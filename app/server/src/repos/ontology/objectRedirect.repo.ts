// Data access for ontology.object_redirects, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  objectRedirectTable,
  type NewObjectRedirect,
  type ObjectRedirect,
  type ObjectRedirectChanges,
} from '../../models/ontology/objectRedirect.model.ts';

export const objectRedirectRepo = {
  insert(db: Queryable, row: NewObjectRedirect): Promise<ObjectRedirect> {
    return insertRow(db, objectRedirectTable, row);
  },

  findById(db: Queryable, id: ObjectRedirect['id']): Promise<ObjectRedirect | undefined> {
    return findRow(db, objectRedirectTable, { id });
  },

  update(
    db: Queryable,
    id: ObjectRedirect['id'],
    changes: ObjectRedirectChanges,
  ): Promise<ObjectRedirect | undefined> {
    return updateRow(db, objectRedirectTable, { id }, changes);
  },

  /** The live redirects out of these objects (object_redirects_live_from). */
  async liveFrom(db: Queryable, siloObjectIds: readonly string[]): Promise<ObjectRedirect[]> {
    if (siloObjectIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${objectRedirectTable.select} from ontology.object_redirects where from_silo_object_id = any($1::uuid[]) and undone_at is null`,
      [siloObjectIds]);
    return rows as ObjectRedirect[];
  },

  /** Undoes a live redirect (a confirmed split). Undefined when it was not live. */
  async undo(db: Queryable, id: string): Promise<ObjectRedirect | undefined> {
    const { rows } = await db.query(
      `update ontology.object_redirects set undone_at = now() where id = $1 and undone_at is null returning ${objectRedirectTable.select}`, [id]);
    return rows[0] as ObjectRedirect | undefined;
  },
};

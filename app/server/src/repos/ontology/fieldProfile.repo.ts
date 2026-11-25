// Data access for ontology.field_profiles, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  fieldProfileTable,
  type FieldProfile,
  type NewFieldProfile,
} from '../../models/ontology/fieldProfile.model.ts';

export const fieldProfileRepo = {
  insert(db: Queryable, row: NewFieldProfile): Promise<FieldProfile> {
    return insertRow(db, fieldProfileTable, row);
  },

  findById(db: Queryable, id: FieldProfile['id']): Promise<FieldProfile | undefined> {
    return findRow(db, fieldProfileTable, { id });
  },

  findByConnectionIdAndSourceObjectAndFieldPathAndProfiledAt(
    db: Queryable,
    key: Pick<FieldProfile, 'organisationId' | 'connectionId' | 'sourceObject' | 'fieldPath' | 'profiledAt'>,
  ): Promise<FieldProfile | undefined> {
    return findRow(db, fieldProfileTable, key);
  },

  /** The latest profile of each field of the connection's objects (counts only). */
  async latestForConnection(db: Queryable, connectionId: string): Promise<FieldProfile[]> {
    const { rows } = await db.query(
      `select distinct on (source_object, field_path) ${fieldProfileTable.select} from ${fieldProfileTable.sql}
       where connection_id = $1 order by source_object, field_path, profiled_at desc limit 5000`, [connectionId]);
    return rows as FieldProfile[];
  },

  /** Each field's newest profiles, at most depth of them, newest first per field. */
  async recentForConnection(db: Queryable, connectionId: string, depth: number): Promise<FieldProfile[]> {
    const { rows } = await db.query(
      `select ${fieldProfileTable.select} from (
         select *, row_number() over (partition by source_object, field_path order by profiled_at desc) as n
         from ${fieldProfileTable.sql} where connection_id = $1) p
       where n <= $2 order by source_object, field_path, profiled_at desc limit 10000`, [connectionId, depth]);
    return rows as FieldProfile[];
  },
};

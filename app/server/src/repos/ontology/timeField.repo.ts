// Data access for ontology.time_fields, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import { timeFieldTable, type NewTimeField, type TimeField } from '../../models/ontology/timeField.model.ts';

export const timeFieldRepo = {
  insert(db: Queryable, row: NewTimeField): Promise<TimeField> {
    return insertRow(db, timeFieldTable, row);
  },

  findById(db: Queryable, id: TimeField['id']): Promise<TimeField | undefined> {
    return findRow(db, timeFieldTable, { id });
  },

  findByObjectTypeVersionIdAndPropertyId(
    db: Queryable,
    key: Pick<TimeField, 'organisationId' | 'objectTypeVersionId' | 'propertyId'>,
  ): Promise<TimeField | undefined> {
    return findRow(db, timeFieldTable, key);
  },

  /** The rows of these object type versions. */
  async listForVersions(db: Queryable, typeVersionIds: readonly string[]): Promise<TimeField[]> {
    if (typeVersionIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${timeFieldTable.select} from ontology.time_fields where object_type_version_id = any($1::uuid[])`, [typeVersionIds]);
    return rows as TimeField[];
  },
};

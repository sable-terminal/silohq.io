// Data access for recognition.associations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  associationTable,
  type Association,
  type NewAssociation,
} from '../../models/recognition/association.model.ts';

export const associationRepo = {
  insert(db: Queryable, row: NewAssociation): Promise<Association> {
    return insertRow(db, associationTable, row);
  },

  findById(db: Queryable, id: Association['id']): Promise<Association | undefined> {
    return findRow(db, associationTable, { id });
  },

  /** One computation's associations, optionally those touching a type. */
  async listFor(db: Queryable, computationId: string, objectTypeId?: string): Promise<Association[]> {
    const { rows } = await db.query(
      `select ${associationTable.select} from recognition.associations
        where computation_id = $1 and ($2::uuid is null or left_object_type_id = $2 or right_object_type_id = $2)
        order by left_object_type_id, right_object_type_id, statement, id`, [computationId, objectTypeId ?? null]);
    return rows as Association[];
  },
};

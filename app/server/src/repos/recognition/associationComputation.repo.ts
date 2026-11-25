// Data access for recognition.association_computations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  associationComputationTable,
  type AssociationComputation,
  type NewAssociationComputation,
} from '../../models/recognition/associationComputation.model.ts';

export const associationComputationRepo = {
  insert(db: Queryable, row: NewAssociationComputation): Promise<AssociationComputation> {
    return insertRow(db, associationComputationTable, row);
  },

  findById(db: Queryable, id: AssociationComputation['id']): Promise<AssociationComputation | undefined> {
    return findRow(db, associationComputationTable, { id });
  },

  /** The current set: the latest computation. */
  async latest(db: Queryable): Promise<AssociationComputation | undefined> {
    const { rows } = await db.query(
      `select ${associationComputationTable.select} from recognition.association_computations order by computed_at desc, id desc limit 1`);
    return rows[0] as AssociationComputation | undefined;
  },
};

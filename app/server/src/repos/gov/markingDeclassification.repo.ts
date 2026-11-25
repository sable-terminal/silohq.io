// Data access for gov.marking_declassifications, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  markingDeclassificationTable,
  type MarkingDeclassification,
  type MarkingDeclassificationChanges,
  type NewMarkingDeclassification,
} from '../../models/gov/markingDeclassification.model.ts';

export const markingDeclassificationRepo = {
  insert(db: Queryable, row: NewMarkingDeclassification): Promise<MarkingDeclassification> {
    return insertRow(db, markingDeclassificationTable, row);
  },

  findById(db: Queryable, id: MarkingDeclassification['id']): Promise<MarkingDeclassification | undefined> {
    return findRow(db, markingDeclassificationTable, { id });
  },

  findByActionIdAndLineageNodeIdAndMarkingId(
    db: Queryable,
    key: Pick<MarkingDeclassification, 'organisationId' | 'actionId' | 'lineageNodeId' | 'markingId'>,
  ): Promise<MarkingDeclassification | undefined> {
    return findRow(db, markingDeclassificationTable, key);
  },

  update(
    db: Queryable,
    id: MarkingDeclassification['id'],
    changes: MarkingDeclassificationChanges,
  ): Promise<MarkingDeclassification | undefined> {
    return updateRow(db, markingDeclassificationTable, { id }, changes);
  },

  /** The latest declassifications, newest first. */
  async latest(db: Queryable, limit: number): Promise<MarkingDeclassification[]> {
    const { rows } = await db.query(
      `select ${markingDeclassificationTable.select} from gov.marking_declassifications order by created_at desc, id desc limit $1`, [limit]);
    return rows as MarkingDeclassification[];
  },
};

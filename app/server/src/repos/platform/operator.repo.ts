// Data access for platform.operators, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by admin-portal (staff.manage, staff.review).
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { operatorTable, type NewOperator, type Operator, type OperatorChanges } from '../../models/platform/operator.model.ts';

export const operatorRepo = {
  findById(db: Queryable, id: Operator['id']): Promise<Operator | undefined> {
    return findRow(db, operatorTable, { id });
  },

  findByIdpSubject(db: Queryable, idpSubject: Operator['idpSubject']): Promise<Operator | undefined> {
    return findRow(db, operatorTable, { idpSubject });
  },

  insert(db: Queryable, row: NewOperator): Promise<Operator> {
    return insertRow(db, operatorTable, row);
  },

  /** Changes the row if it is still at `version`; undefined when someone changed it first. */
  update(db: Queryable, id: string, version: number, changes: OperatorChanges): Promise<Operator | undefined> {
    return updateRow(db, operatorTable, { id, version }, { ...changes, version: version + 1 });
  },

  /** Staff not removed, by name; `reviewDueBefore` keeps only those last reviewed before it, or never. */
  async list(db: Queryable, options: { reviewDueBefore?: string | undefined; limit: number }): Promise<Operator[]> {
    const { rows } = await db.query(
      `select ${operatorTable.select} from ${operatorTable.sql}
       where status <> 'removed' and ($1::timestamptz is null or last_reviewed_at is null or last_reviewed_at < $1)
       order by display_name, id limit $2`, [options.reviewDueBefore ?? null, options.limit]);
    return rows as Operator[];
  },
};

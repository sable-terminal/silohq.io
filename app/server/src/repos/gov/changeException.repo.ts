// Data access for gov.change_exceptions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  changeExceptionTable,
  type ChangeException,
  type NewChangeException,
} from '../../models/gov/changeException.model.ts';

export const changeExceptionRepo = {
  insert(db: Queryable, row: NewChangeException): Promise<ChangeException> {
    return insertRow(db, changeExceptionTable, row);
  },

  findById(db: Queryable, id: ChangeException['id']): Promise<ChangeException | undefined> {
    return findRow(db, changeExceptionTable, { id });
  },

  findByFreezeIdAndReleaseId(
    db: Queryable,
    key: Pick<ChangeException, 'organisationId' | 'freezeId' | 'releaseId'>,
  ): Promise<ChangeException | undefined> {
    return findRow(db, changeExceptionTable, key);
  },

  /** The approvals made in these freezes, oldest first. */
  async forFreezes(db: Queryable, organisationId: string, freezeIds: readonly string[]): Promise<ChangeException[]> {
    if (freezeIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${changeExceptionTable.select} from gov.change_exceptions
        where organisation_id = $1 and freeze_id = any($2::uuid[]) order by approved_at, id`, [organisationId, freezeIds]);
    return rows as ChangeException[];
  },
};

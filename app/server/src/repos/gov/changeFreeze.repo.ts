// Data access for gov.change_freezes, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  changeFreezeTable,
  type ChangeFreeze,
  type ChangeFreezeChanges,
  type NewChangeFreeze,
} from '../../models/gov/changeFreeze.model.ts';

export const changeFreezeRepo = {
  insert(db: Queryable, row: NewChangeFreeze): Promise<ChangeFreeze> {
    return insertRow(db, changeFreezeTable, row);
  },

  findById(db: Queryable, id: ChangeFreeze['id']): Promise<ChangeFreeze | undefined> {
    return findRow(db, changeFreezeTable, { id });
  },

  update(
    db: Queryable,
    id: ChangeFreeze['id'],
    changes: ChangeFreezeChanges,
  ): Promise<ChangeFreeze | undefined> {
    return updateRow(db, changeFreezeTable, { id }, changes);
  },

  /** The organisation's freezes not yet over (ended early: over at that moment), earliest first. */
  async current(db: Queryable, organisationId: string, now: string): Promise<ChangeFreeze[]> {
    const { rows } = await db.query(
      `select ${changeFreezeTable.select} from gov.change_freezes
        where organisation_id = $1 and least(ends_at, coalesce(ended_at, ends_at)) > $2 order by starts_at, id`, [organisationId, now]);
    return rows as ChangeFreeze[];
  },
};

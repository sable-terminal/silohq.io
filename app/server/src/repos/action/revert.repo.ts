// Data access for action.reverts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  revertTable,
  type NewRevert,
  type Revert,
  type RevertChanges,
} from '../../models/action/revert.model.ts';

export const revertRepo = {
  insert(db: Queryable, row: NewRevert): Promise<Revert> {
    return insertRow(db, revertTable, row);
  },

  findById(db: Queryable, id: Revert['id']): Promise<Revert | undefined> {
    return findRow(db, revertTable, { id });
  },

  findByNewMutationId(
    db: Queryable,
    key: Pick<Revert, 'organisationId' | 'newMutationId'>,
  ): Promise<Revert | undefined> {
    return findRow(db, revertTable, key);
  },

  update(db: Queryable, id: Revert['id'], changes: RevertChanges): Promise<Revert | undefined> {
    return updateRow(db, revertTable, { id }, changes);
  },
};

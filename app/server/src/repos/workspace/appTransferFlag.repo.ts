// Data access for workspace.app_transfer_flags, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  appTransferFlagTable,
  type AppTransferFlag,
  type AppTransferFlagChanges,
  type NewAppTransferFlag,
} from '../../models/workspace/appTransferFlag.model.ts';

export const appTransferFlagRepo = {
  insert(db: Queryable, row: NewAppTransferFlag): Promise<AppTransferFlag> {
    return insertRow(db, appTransferFlagTable, row);
  },

  findById(db: Queryable, id: AppTransferFlag['id']): Promise<AppTransferFlag | undefined> {
    return findRow(db, appTransferFlagTable, { id });
  },

  update(
    db: Queryable,
    id: AppTransferFlag['id'],
    changes: AppTransferFlagChanges,
  ): Promise<AppTransferFlag | undefined> {
    return updateRow(db, appTransferFlagTable, { id }, changes);
  },

  /** A receiving admin's inherited apps not yet reviewed, oldest first. */
  async listOpenFor(db: Queryable, membershipId: string): Promise<AppTransferFlag[]> {
    const { rows } = await db.query(
      `select ${appTransferFlagTable.select} from workspace.app_transfer_flags where transferred_to = $1 and reviewed_at is null order by created_at, id`,
      [membershipId]);
    return rows as AppTransferFlag[];
  },
};

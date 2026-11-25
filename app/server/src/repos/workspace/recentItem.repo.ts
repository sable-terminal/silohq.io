// Data access for workspace.recent_items, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  recentItemTable,
  type NewRecentItem,
  type RecentItem,
  type RecentItemChanges,
} from '../../models/workspace/recentItem.model.ts';

export const recentItemRepo = {
  insert(db: Queryable, row: NewRecentItem): Promise<RecentItem> {
    return insertRow(db, recentItemTable, row);
  },

  findById(db: Queryable, id: RecentItem['id']): Promise<RecentItem | undefined> {
    return findRow(db, recentItemTable, { id });
  },

  update(db: Queryable, id: RecentItem['id'], changes: RecentItemChanges): Promise<RecentItem | undefined> {
    return updateRow(db, recentItemTable, { id }, changes);
  },

  remove(db: Queryable, id: RecentItem['id']): Promise<boolean> {
    return deleteRow(db, recentItemTable, { id });
  },
};

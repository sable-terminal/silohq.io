// Data access for workspace.app_branches, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  appBranchTable,
  type AppBranch,
  type AppBranchChanges,
  type NewAppBranch,
} from '../../models/workspace/appBranch.model.ts';

export const appBranchRepo = {
  insert(db: Queryable, row: NewAppBranch): Promise<AppBranch> {
    return insertRow(db, appBranchTable, row);
  },

  findById(db: Queryable, id: AppBranch['id']): Promise<AppBranch | undefined> {
    return findRow(db, appBranchTable, { id });
  },

  update(db: Queryable, id: AppBranch['id'], changes: AppBranchChanges): Promise<AppBranch | undefined> {
    return updateRow(db, appBranchTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<AppBranch | undefined> {
    const { rows } = await db.query(`select ${appBranchTable.select} from workspace.app_branches where id = $1 for update`, [id]);
    return rows[0] as AppBranch | undefined;
  },

  /** An app's branches, open first, newest first within each. */
  async listForApp(db: Queryable, appId: string): Promise<AppBranch[]> {
    const { rows } = await db.query(
      `select ${appBranchTable.select} from workspace.app_branches where app_id = $1 order by (status = 'open') desc, created_at desc limit 200`, [appId]);
    return rows as AppBranch[];
  },

  /** Whether an open branch of the app already has the name. */
  async openNamed(db: Queryable, appId: string, name: string): Promise<boolean> {
    const { rows } = await db.query(`select 1 from workspace.app_branches where app_id = $1 and name = $2 and status = 'open' limit 1`, [appId, name]);
    return rows.length > 0;
  },
};

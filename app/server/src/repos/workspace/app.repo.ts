// Data access for workspace.apps, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { appTable, type App, type AppChanges, type NewApp } from '../../models/workspace/app.model.ts';

export const appRepo = {
  insert(db: Queryable, row: NewApp): Promise<App> {
    return insertRow(db, appTable, row);
  },

  findById(db: Queryable, id: App['id']): Promise<App | undefined> {
    return findRow(db, appTable, { id });
  },

  update(db: Queryable, id: App['id'], changes: AppChanges): Promise<App | undefined> {
    return updateRow(db, appTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<App | undefined> {
    const { rows } = await db.query(`select ${appTable.select} from workspace.apps where id = $1 for update`, [id]);
    return rows[0] as App | undefined;
  },

  /** A member's own apps, newest first: live or archived. */
  async listOwned(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<App[]> {
    const { rows } = await db.query(
      `select ${appTable.select} from workspace.apps
       where owner_membership_id = $1 and kind = 'app' and (archived_at is not null) = $2 order by updated_at desc, id limit $3`,
      [membershipId, archived, limit]);
    return rows as App[];
  },

  async findMany(db: Queryable, ids: readonly string[], limit: number): Promise<App[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${appTable.select} from workspace.apps where id = any($1::uuid[]) and archived_at is null order by updated_at desc, id limit $2`,
      [ids, limit]);
    return rows as App[];
  },

  /** The live apps a member owns, locked for a transfer. */
  async ownedLiveForUpdate(db: Queryable, ownerId: string): Promise<App[]> {
    const { rows } = await db.query(
      `select ${appTable.select} from workspace.apps where owner_membership_id = $1 and archived_at is null order by id for update`, [ownerId]);
    return rows as App[];
  },
};

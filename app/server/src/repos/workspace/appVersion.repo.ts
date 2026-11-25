// Data access for workspace.app_versions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  appVersionTable,
  type AppVersion,
  type AppVersionChanges,
  type NewAppVersion,
} from '../../models/workspace/appVersion.model.ts';

export const appVersionRepo = {
  insert(db: Queryable, row: NewAppVersion): Promise<AppVersion> {
    return insertRow(db, appVersionTable, row);
  },

  /** Marks the version invalidated at this ontology version; false when it was marked at it already. */
  async markInvalidated(db: Queryable, id: string, ontologyVersion: number): Promise<boolean> {
    const { rowCount } = await db.query(
      `update workspace.app_versions set invalidated_at_ontology_version = $2
        where id = $1 and invalidated_at_ontology_version is distinct from $2`, [id, ontologyVersion]);
    return (rowCount ?? 0) > 0;
  },

  findById(db: Queryable, id: AppVersion['id']): Promise<AppVersion | undefined> {
    return findRow(db, appVersionTable, { id });
  },

  findByAppIdAndVersion(
    db: Queryable,
    key: Pick<AppVersion, 'organisationId' | 'appId' | 'version'>,
  ): Promise<AppVersion | undefined> {
    return findRow(db, appVersionTable, key);
  },

  update(db: Queryable, id: AppVersion['id'], changes: AppVersionChanges): Promise<AppVersion | undefined> {
    return updateRow(db, appVersionTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, appId: string, version: number): Promise<AppVersion | undefined> {
    const { rows } = await db.query(
      `select ${appVersionTable.select} from workspace.app_versions where app_id = $1 and version = $2 for update`, [appId, version]);
    return rows[0] as AppVersion | undefined;
  },

  /** Every version of an app, newest first. */
  async listForApp(db: Queryable, appId: string): Promise<AppVersion[]> {
    const { rows } = await db.query(
      `select ${appVersionTable.select} from workspace.app_versions where app_id = $1 order by version desc`, [appId]);
    return rows as AppVersion[];
  },

  async nextVersion(db: Queryable, appId: string): Promise<number> {
    const { rows } = await db.query('select coalesce(max(version), 0) + 1 as next from workspace.app_versions where app_id = $1', [appId]);
    return Number((rows[0] as { next: number | string }).next);
  },

  /** The app's version in progress (draft, review or returned, newest), if any. */
  async inProgress(db: Queryable, appId: string): Promise<AppVersion | undefined> {
    const { rows } = await db.query(
      `select ${appVersionTable.select} from workspace.app_versions
       where app_id = $1 and branch_id is null and state in ('draft', 'review', 'returned') order by version desc limit 1`, [appId]);
    return rows[0] as AppVersion | undefined;
  },

  /** A branch's draft (D229): one per branch. */
  async branchDraft(db: Queryable, branchId: string): Promise<AppVersion | undefined> {
    const { rows } = await db.query(`select ${appVersionTable.select} from workspace.app_versions where branch_id = $1 limit 1`, [branchId]);
    return rows[0] as AppVersion | undefined;
  },

  /** The published version, locked: one at a time per app. */
  async publishedForUpdate(db: Queryable, appId: string): Promise<AppVersion | undefined> {
    const { rows } = await db.query(
      `select ${appVersionTable.select} from workspace.app_versions where app_id = $1 and state = 'published' for update`, [appId]);
    return rows[0] as AppVersion | undefined;
  },
};

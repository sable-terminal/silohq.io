// Data access for workspace.app_releases, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  appReleaseTable,
  type AppRelease,
  type AppReleaseChanges,
  type NewAppRelease,
} from '../../models/workspace/appRelease.model.ts';

export const appReleaseRepo = {
  insert(db: Queryable, row: NewAppRelease): Promise<AppRelease> {
    return insertRow(db, appReleaseTable, row);
  },

  findById(db: Queryable, id: AppRelease['id']): Promise<AppRelease | undefined> {
    return findRow(db, appReleaseTable, { id });
  },

  update(db: Queryable, id: AppRelease['id'], changes: AppReleaseChanges): Promise<AppRelease | undefined> {
    return updateRow(db, appReleaseTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<AppRelease | undefined> {
    const { rows } = await db.query(`select ${appReleaseTable.select} from workspace.app_releases where id = $1 for update`, [id]);
    return rows[0] as AppRelease | undefined;
  },

  /** The app's latest release, which decides who opens which version. */
  async latest(db: Queryable, appId: string): Promise<AppRelease | undefined> {
    const { rows } = await db.query(
      `select ${appReleaseTable.select} from workspace.app_releases where app_id = $1 order by started_at desc, id desc limit 1`, [appId]);
    return rows[0] as AppRelease | undefined;
  },

  async listForApp(db: Queryable, appId: string): Promise<AppRelease[]> {
    const { rows } = await db.query(
      `select ${appReleaseTable.select} from workspace.app_releases where app_id = $1 order by started_at desc, id desc limit 50`, [appId]);
    return rows as AppRelease[];
  },

  /** Whether a member sits in a scope (or below one) of a released stage of the release. */
  async reaches(db: Queryable, releaseId: string, membershipId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select 1 from workspace.app_release_stages st
       join iam.scopes anchor on anchor.organisation_id = st.organisation_id and anchor.id = any(st.scope_ids)
       join iam.scopes s on s.organisation_id = anchor.organisation_id and s.path <@ anchor.path
       join iam.scope_memberships sm on sm.organisation_id = s.organisation_id and sm.scope_id = s.id
       where st.release_id = $1 and st.released_at is not null and sm.membership_id = $2 and sm.inactive_since is null
       limit 1`, [releaseId, membershipId]);
    return rows.length > 0;
  },
};

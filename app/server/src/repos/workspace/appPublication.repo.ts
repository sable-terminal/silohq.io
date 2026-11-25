// Data access for workspace.app_publications, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { SCOPES_CONTAINING_MEMBER } from './savedView.repo.ts';
import {
  appPublicationTable,
  type AppPublication,
  type AppPublicationChanges,
  type NewAppPublication,
} from '../../models/workspace/appPublication.model.ts';

export const appPublicationRepo = {
  insert(db: Queryable, row: NewAppPublication): Promise<AppPublication> {
    return insertRow(db, appPublicationTable, row);
  },

  findById(db: Queryable, id: AppPublication['id']): Promise<AppPublication | undefined> {
    return findRow(db, appPublicationTable, { id });
  },

  update(
    db: Queryable,
    id: AppPublication['id'],
    changes: AppPublicationChanges,
  ): Promise<AppPublication | undefined> {
    return updateRow(db, appPublicationTable, { id }, changes);
  },

  async findLive(db: Queryable, appId: string, scopeId: string): Promise<AppPublication | undefined> {
    const { rows } = await db.query(
      `select ${appPublicationTable.select} from workspace.app_publications where app_id = $1 and scope_id = $2 and withdrawn_at is null for update`,
      [appId, scopeId]);
    return rows[0] as AppPublication | undefined;
  },

  async liveForApp(db: Queryable, appId: string): Promise<AppPublication[]> {
    const { rows } = await db.query(
      `select ${appPublicationTable.select} from workspace.app_publications where app_id = $1 and withdrawn_at is null order by published_at, id`,
      [appId]);
    return rows as AppPublication[];
  },

  /** A live publication of the app on a scope whose subtree holds one of the member's scopes. */
  async reachesMember(db: Queryable, appId: string, membershipId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from workspace.app_publications p
                      where p.app_id = $2 and p.withdrawn_at is null and p.scope_id in (${SCOPES_CONTAINING_MEMBER})) as yes`,
      [membershipId, appId]);
    return (rows[0] as { yes: boolean }).yes;
  },

  /** Apps published to scopes the member sits within: their directory. */
  async appsReaching(db: Queryable, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct app_id as id from workspace.app_publications
       where withdrawn_at is null and scope_id in (${SCOPES_CONTAINING_MEMBER})`, [membershipId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  /** Advances every live publication of an app to its newly published version. */
  async advance(db: Queryable, appId: string, appVersionId: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.app_publications set app_version_id = $2 where app_id = $1 and withdrawn_at is null', [appId, appVersionId]);
    return rowCount ?? 0;
  },

  /** Whether the organisation has any app published and not withdrawn (the AI FDE's stage 6, spec 50.9). */
  async anyLive(db: Queryable): Promise<boolean> {
    const { rows } = await db.query('select exists (select 1 from workspace.app_publications where withdrawn_at is null) as found');
    return (rows[0] as { found: boolean }).found;
  },
};

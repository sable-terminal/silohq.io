// Data access for workspace.app_shares, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { SCOPES_CONTAINING_MEMBER } from './savedView.repo.ts';
import {
  appShareTable,
  type AppShare,
  type AppShareChanges,
  type NewAppShare,
} from '../../models/workspace/appShare.model.ts';

export const appShareRepo = {
  insert(db: Queryable, row: NewAppShare): Promise<AppShare> {
    return insertRow(db, appShareTable, row);
  },

  findById(db: Queryable, id: AppShare['id']): Promise<AppShare | undefined> {
    return findRow(db, appShareTable, { id });
  },

  update(db: Queryable, id: AppShare['id'], changes: AppShareChanges): Promise<AppShare | undefined> {
    return updateRow(db, appShareTable, { id }, changes);
  },

  /** The shares of an app that reach a member now: to them, a scope containing one of theirs, or everyone. */
  async liveReaching(db: Queryable, appId: string, membershipId: string): Promise<AppShare[]> {
    const { rows } = await db.query(
      `select ${appShareTable.select} from workspace.app_shares
       where app_id = $2 and revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId, appId]);
    return rows as AppShare[];
  },

  async listForApp(db: Queryable, appId: string): Promise<AppShare[]> {
    const { rows } = await db.query(`select ${appShareTable.select} from workspace.app_shares where app_id = $1 order by shared_at, id`, [appId]);
    return rows as AppShare[];
  },

  async findForGrantee(db: Queryable, appId: string, grantee: { membershipId?: string; scopeId?: string; organisation?: true }): Promise<AppShare | undefined> {
    const { rows } = await db.query(
      `select ${appShareTable.select} from workspace.app_shares
       where app_id = $1 and (($2::uuid is not null and membership_id = $2) or ($3::uuid is not null and scope_id = $3) or ($4 and organisation_wide))
       for update`,
      [appId, grantee.membershipId ?? null, grantee.scopeId ?? null, grantee.organisation === true]);
    return rows[0] as AppShare | undefined;
  },

  async revokeAll(db: Queryable, appId: string, at: string): Promise<number> {
    const { rowCount } = await db.query('update workspace.app_shares set revoked_at = $2 where app_id = $1 and revoked_at is null', [appId, at]);
    return rowCount ?? 0;
  },

  /** Apps shared with a member and live now. */
  async appsReaching(db: Queryable, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct app_id as id from workspace.app_shares
       where revoked_at is null and suspended_at is null and (expires_at is null or expires_at > now())
         and (membership_id = $1 or organisation_wide or scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  async suspendLive(db: Queryable, appId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.app_shares set suspended_at = $2 where app_id = $1 and revoked_at is null and suspended_at is null', [appId, at]);
    return rowCount ?? 0;
  },

  async resumeSuspended(db: Queryable, appId: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.app_shares set suspended_at = null where app_id = $1 and revoked_at is null and suspended_at is not null', [appId]);
    return rowCount ?? 0;
  },

  /** Every share made to a departing member, of anyone's app. */
  async revokeToMembership(db: Queryable, membershipId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      'update workspace.app_shares set revoked_at = $2 where membership_id = $1 and revoked_at is null', [membershipId, at]);
    return rowCount ?? 0;
  },
};

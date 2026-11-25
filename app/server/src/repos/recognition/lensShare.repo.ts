// Data access for recognition.lens_shares, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { SCOPES_CONTAINING_MEMBER } from '../workspace/savedView.repo.ts';
import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  lensShareTable,
  type LensShare,
  type LensShareChanges,
  type NewLensShare,
} from '../../models/recognition/lensShare.model.ts';

export const lensShareRepo = {
  insert(db: Queryable, row: NewLensShare): Promise<LensShare> {
    return insertRow(db, lensShareTable, row);
  },

  findById(db: Queryable, id: LensShare['id']): Promise<LensShare | undefined> {
    return findRow(db, lensShareTable, { id });
  },

  update(db: Queryable, id: LensShare['id'], changes: LensShareChanges): Promise<LensShare | undefined> {
    return updateRow(db, lensShareTable, { id }, changes);
  },

  /** Live shares of a Lens that reach a member: directly, through a scope containing one of theirs, or the organisation. */
  async liveReaching(db: Queryable, lensId: string, membershipId: string): Promise<LensShare[]> {
    const { rows } = await db.query(
      `select ${lensShareTable.select} from recognition.lens_shares
        where lens_id = $2 and revoked_at is null
          and (grantee_membership_id = $1 or grantee_whole_organisation or grantee_scope_id in (${SCOPES_CONTAINING_MEMBER}))`,
      [membershipId, lensId]);
    return rows as LensShare[];
  },

  /** Every Lens id a live share reaches the member with. */
  async lensesReaching(db: Queryable, membershipId: string, limit: number): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct lens_id from recognition.lens_shares
        where revoked_at is null
          and (grantee_membership_id = $1 or grantee_whole_organisation or grantee_scope_id in (${SCOPES_CONTAINING_MEMBER}))
        limit $2`, [membershipId, limit]);
    return rows.map((r) => (r as { lens_id: string }).lens_id);
  },

  async listForLens(db: Queryable, lensId: string): Promise<LensShare[]> {
    const { rows } = await db.query(`select ${lensShareTable.select} from recognition.lens_shares where lens_id = $1 order by created_at, id`, [lensId]);
    return rows as LensShare[];
  },

  async revoke(db: Queryable, id: string, membershipId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'update recognition.lens_shares set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null', [id, membershipId]);
    return rowCount === 1;
  },

  /** Who a scope grantee reaches (members whose active scope sits within it), bounded: for coverage at share. */
  async membersWithin(db: Queryable, scopeId: string, limit: number): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct sm.membership_id from iam.scope_memberships sm
         join iam.scopes mine on mine.organisation_id = sm.organisation_id and mine.id = sm.scope_id
         join iam.scopes target on target.organisation_id = mine.organisation_id and target.id = $1
         join iam.memberships m on m.organisation_id = sm.organisation_id and m.id = sm.membership_id and m.status = 'active'
        where mine.path <@ target.path and sm.inactive_since is null
        order by sm.membership_id limit $2`, [scopeId, limit]);
    return rows.map((r) => (r as { membership_id: string }).membership_id);
  },

  /** The organisation's active members, bounded: for coverage of an organisation-wide share. */
  async activeMembers(db: Queryable, limit: number): Promise<string[]> {
    const { rows } = await db.query(`select id from iam.memberships where status = 'active' order by id limit $1`, [limit]);
    return rows.map((r) => (r as { id: string }).id);
  },
};

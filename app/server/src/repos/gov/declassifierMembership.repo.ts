// Data access for gov.declassifier_memberships, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  declassifierMembershipTable,
  type DeclassifierMembership,
  type DeclassifierMembershipChanges,
  type NewDeclassifierMembership,
} from '../../models/gov/declassifierMembership.model.ts';

export const declassifierMembershipRepo = {
  insert(db: Queryable, row: NewDeclassifierMembership): Promise<DeclassifierMembership> {
    return insertRow(db, declassifierMembershipTable, row);
  },

  findById(db: Queryable, id: DeclassifierMembership['id']): Promise<DeclassifierMembership | undefined> {
    return findRow(db, declassifierMembershipTable, { id });
  },

  update(
    db: Queryable,
    id: DeclassifierMembership['id'],
    changes: DeclassifierMembershipChanges,
  ): Promise<DeclassifierMembership | undefined> {
    return updateRow(db, declassifierMembershipTable, { id }, changes);
  },

  /** Whether the member is a live declassifier of the marking: approved, unexpired, unrevoked, directly or through a scope of theirs. */
  async liveFor(db: Queryable, markingId: string, membershipId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select 1 from gov.declassifier_memberships d
        where d.marking_id = $2 and d.approved_at is not null and d.revoked_at is null and (d.expires_at is null or d.expires_at > now())
          and (d.membership_id = $1 or d.scope_id in (
            select sc.id from iam.scope_memberships sm
              join iam.scopes mine on mine.organisation_id = sm.organisation_id and mine.id = sm.scope_id
              join iam.scopes sc on sc.organisation_id = mine.organisation_id and mine.path <@ sc.path
             where sm.membership_id = $1 and sm.inactive_since is null))
        limit 1`, [membershipId, markingId]);
    return rows.length > 0;
  },

  async list(db: Queryable, markingId: string | undefined): Promise<DeclassifierMembership[]> {
    const { rows } = await db.query(
      `select ${declassifierMembershipTable.select} from gov.declassifier_memberships where ($1::uuid is null or marking_id = $1)
        order by granted_at desc, id limit 500`, [markingId ?? null]);
    return rows as DeclassifierMembership[];
  },

  async approve(db: Queryable, id: string, membershipId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update gov.declassifier_memberships set approved_by = $2, approved_at = now()
        where id = $1 and approved_at is null and revoked_at is null and granted_by <> $2`, [id, membershipId]);
    return rowCount === 1;
  },

  async revoke(db: Queryable, id: string, membershipId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'update gov.declassifier_memberships set revoked_by = $2, revoked_at = now() where id = $1 and revoked_at is null', [id, membershipId]);
    return rowCount === 1;
  },
};

// Data access for iam.scope_memberships, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  scopeMembershipTable,
  type NewScopeMembership,
  type ScopeMembership,
  type ScopeMembershipChanges,
} from '../../models/iam/scopeMembership.model.ts';

export const scopeMembershipRepo = {
  insert(db: Queryable, row: NewScopeMembership): Promise<ScopeMembership> {
    return insertRow(db, scopeMembershipTable, row);
  },

  findById(db: Queryable, id: ScopeMembership['id']): Promise<ScopeMembership | undefined> {
    return findRow(db, scopeMembershipTable, { id });
  },

  findByMembershipIdAndScopeId(
    db: Queryable,
    key: Pick<ScopeMembership, 'organisationId' | 'membershipId' | 'scopeId'>,
  ): Promise<ScopeMembership | undefined> {
    return findRow(db, scopeMembershipTable, key);
  },

  update(
    db: Queryable,
    id: ScopeMembership['id'],
    changes: ScopeMembershipChanges,
  ): Promise<ScopeMembership | undefined> {
    return updateRow(db, scopeMembershipTable, { id }, changes);
  },

  // The paths of the live scopes a membership sits in (inactive rows are kept but never
  // resolve, spec 56.4, 55.7).
  /** A scope's active members, primary first. */
  async activeForScope(db: Queryable, scopeId: string): Promise<ScopeMembership[]> {
    const { rows } = await db.query(
      `select ${scopeMembershipTable.select} from iam.scope_memberships where scope_id = $1 and inactive_since is null order by is_primary desc, id`, [scopeId]);
    return rows as ScopeMembership[];
  },

  async activeScopePaths(db: Queryable, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select s.path::text as path from iam.scope_memberships sm
       join iam.scopes s on s.organisation_id = sm.organisation_id and s.id = sm.scope_id
       where sm.membership_id = $1 and sm.inactive_since is null and s.archived_at is null
       order by s.path`, [membershipId]);
    return rows.map((r) => (r as { path: string }).path);
  },

  /** Removal takes a membership's scopes out of resolution, keeping the rows (spec 55.7, 56.4). */
  async deactivateForMembership(db: Queryable, membershipId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      'update iam.scope_memberships set inactive_since = $2 where membership_id = $1 and inactive_since is null', [membershipId, at]);
    return rowCount ?? 0;
  },

  /** Reinstatement restores the scopes its removal took out of resolution. */
  async restoreForMembership(db: Queryable, membershipId: string): Promise<number> {
    const { rowCount } = await db.query(
      `update iam.scope_memberships sm set inactive_since = null
       from iam.memberships m
       where m.organisation_id = sm.organisation_id and m.id = sm.membership_id and sm.membership_id = $1
         and sm.inactive_since = m.removed_at`, [membershipId]);
    return rowCount ?? 0;
  },

  /** The live scope memberships of a membership, with each scope's path. */
  async activeScopes(db: Queryable, membershipId: string): Promise<{ id: string; scopeId: string; path: string }[]> {
    const { rows } = await db.query(
      `select sm.id, sm.scope_id as "scopeId", s.path::text as path from iam.scope_memberships sm
       join iam.scopes s on s.organisation_id = sm.organisation_id and s.id = sm.scope_id
       where sm.membership_id = $1 and sm.inactive_since is null and s.archived_at is null order by s.path`, [membershipId]);
    return rows as { id: string; scopeId: string; path: string }[];
  },
};

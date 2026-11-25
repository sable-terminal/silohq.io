// Data access for iam.role_assignments, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  roleAssignmentTable,
  type NewRoleAssignment,
  type RoleAssignment,
  type RoleAssignmentChanges,
} from '../../models/iam/roleAssignment.model.ts';

/** A live role assignment as the policy service resolves it. */
export interface LiveAssignment extends LiveGrant {
  roleId: string;
  expiresAt: string | null;
}

export interface LiveGrant {
  permissions: string[];
  scopePath: string | null;
  resourceType: 'connection' | 'silo' | 'view' | 'object_type' | 'app' | null;
  resourceId: string | null;
}

export const roleAssignmentRepo = {
  insert(db: Queryable, row: NewRoleAssignment): Promise<RoleAssignment> {
    return insertRow(db, roleAssignmentTable, row);
  },

  findById(db: Queryable, id: RoleAssignment['id']): Promise<RoleAssignment | undefined> {
    return findRow(db, roleAssignmentTable, { id });
  },

  update(
    db: Queryable,
    id: RoleAssignment['id'],
    changes: RoleAssignmentChanges,
  ): Promise<RoleAssignment | undefined> {
    return updateRow(db, roleAssignmentTable, { id }, changes);
  },

  // The membership's live grants (spec 57.6 step 1): unrevoked, unsilenced, unexpired, each
  // with its role's permissions and where it applies.
  async liveGrants(db: Queryable, membershipId: string): Promise<LiveGrant[]> {
    const { rows } = await db.query(
      `select coalesce(array_agg(rp.permission_id order by rp.permission_id) filter (where rp.permission_id is not null), '{}') as permissions,
              s.path::text as "scopePath",
              case when ra.on_connection_id is not null then 'connection' when ra.on_silo_id is not null then 'silo'
                   when ra.on_view_id is not null then 'view' when ra.on_object_type_id is not null then 'object_type'
                   when ra.on_app_id is not null then 'app' end as "resourceType",
              coalesce(ra.on_connection_id, ra.on_silo_id, ra.on_view_id, ra.on_object_type_id, ra.on_app_id) as "resourceId"
       from iam.role_assignments ra
       left join iam.scopes s on s.organisation_id = ra.organisation_id and s.id = ra.on_scope_id
       left join iam.role_permissions rp on rp.organisation_id = ra.organisation_id and rp.role_id = ra.role_id
       where ra.membership_id = $1 and ra.revoked_at is null and ra.silenced_at is null
         and (ra.expires_at is null or ra.expires_at > now())
       group by ra.id, s.path`, [membershipId]);
    return rows as LiveGrant[];
  },

  // Why a membership may not grant a role at a scope (null: organisation-wide), or null
  // when it may: the delegation rules the database enforces on insert (spec 56.7).
  async grantRefusal(db: Queryable, organisationId: string, granter: string, roleId: string, scopeId: string | null)
    : Promise<string | null> {
    const { rows } = await db.query('select iam.check_grant($1, $2, $3, $4) as refusal', [organisationId, granter, roleId, scopeId]);
    return (rows[0] as { refusal: string | null }).refusal;
  },

  // The founding super admin of a signed-up organisation (D78), through the definer function.
  async grantFoundingSuperAdmin(db: Queryable, organisationId: string, membershipId: string): Promise<string> {
    const { rows } = await db.query('select iam.grant_founding_super_admin($1, $2) as id', [organisationId, membershipId]);
    return (rows[0] as { id: string }).id;
  },

  /** The synthetic organisation's two members, each a Super admin (definer function: there alone, once). */
  async grantSyntheticMembers(db: Queryable, organisationId: string, first: string, second: string): Promise<void> {
    await db.query('select iam.grant_synthetic_members($1, $2, $3)', [organisationId, first, second]);
  },

  // The scope a granter administers the target from, for granted_at_scope_id (spec 56.8).
  async actingScope(db: Queryable, organisationId: string, granter: string, scopeId: string): Promise<string | null> {
    const { rows } = await db.query('select iam.acting_scope($1, $2, $3) as scope', [organisationId, granter, scopeId]);
    return (rows[0] as { scope: string | null }).scope;
  },

  /**
   * The membership's live assignments (spec 57.6 step 1) with their roles' permissions,
   * where each applies and when it ends, for the policy service's resolved authority.
   */
  async liveAssignments(db: Queryable, membershipId: string): Promise<LiveAssignment[]> {
    const { rows } = await db.query(
      `select ra.role_id as "roleId",
              coalesce(array_agg(rp.permission_id order by rp.permission_id) filter (where rp.permission_id is not null), '{}') as permissions,
              s.path::text as "scopePath",
              case when ra.on_connection_id is not null then 'connection' when ra.on_silo_id is not null then 'silo'
                   when ra.on_view_id is not null then 'view' when ra.on_object_type_id is not null then 'object_type'
                   when ra.on_app_id is not null then 'app' end as "resourceType",
              coalesce(ra.on_connection_id, ra.on_silo_id, ra.on_view_id, ra.on_object_type_id, ra.on_app_id) as "resourceId",
              ra.expires_at as "expiresAt"
       from iam.role_assignments ra
       join iam.roles r on r.organisation_id = ra.organisation_id and r.id = ra.role_id and r.retired_at is null
       left join iam.scopes s on s.organisation_id = ra.organisation_id and s.id = ra.on_scope_id
       left join iam.role_permissions rp on rp.organisation_id = ra.organisation_id and rp.role_id = ra.role_id
       where ra.membership_id = $1 and ra.revoked_at is null and ra.silenced_at is null and (ra.expires_at is null or ra.expires_at > now())
       group by ra.id, s.path`, [membershipId]);
    return rows as LiveAssignment[];
  },

  /**
   * Active members holding the permission organisation-wide through a live assignment:
   * whom to tell when something waits for that permission (break-glass approval, 13.3).
   */
  async holdersOf(db: Queryable, permission: string, limit = 100): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct ra.membership_id as id
       from iam.role_assignments ra
       join iam.role_permissions rp on rp.organisation_id = ra.organisation_id and rp.role_id = ra.role_id
       join iam.memberships m on m.organisation_id = ra.organisation_id and m.id = ra.membership_id
       where rp.permission_id = $1 and m.status = 'active' and ra.revoked_at is null and ra.silenced_at is null
         and (ra.expires_at is null or ra.expires_at > now())
         and num_nonnulls(ra.on_scope_id, ra.on_connection_id, ra.on_silo_id, ra.on_view_id, ra.on_object_type_id, ra.on_app_id) = 0
       order by ra.membership_id limit $2`, [permission, limit]);
    return rows.map((r) => (r as { id: string }).id);
  },

  async isSuperAdmin(db: Queryable, organisationId: string, membershipId: string): Promise<boolean> {
    const { rows } = await db.query('select iam.is_super_admin($1, $2) as yes', [organisationId, membershipId]);
    return (rows[0] as { yes: boolean }).yes;
  },

  /** Unrevoked assignments of a membership, silenced ones included, newest first. */
  async listForMembership(db: Queryable, membershipId: string): Promise<RoleAssignment[]> {
    const { rows } = await db.query(
      `select ${roleAssignmentTable.select} from iam.role_assignments where membership_id = $1 and revoked_at is null
       order by granted_at desc`, [membershipId]);
    return rows as RoleAssignment[];
  },

  /** Live assignments this membership issued to others: what becomes the orphan list when its authority goes (spec 56.8). */
  async countLiveIssuedBy(db: Queryable, granter: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from iam.role_assignments ra
       where ra.granted_by = $1 and ra.membership_id <> $1 and ra.revoked_at is null`, [granter]);
    return (rows[0] as { n: number }).n;
  },

  /** Suspension and removal silence every live assignment without revoking it (spec 55.7, 56.8), at the membership's own suspended_at or removed_at. */
  async silenceForMembership(db: Queryable, membershipId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      `update iam.role_assignments set silenced_at = $2
       where membership_id = $1 and revoked_at is null and silenced_at is null`, [membershipId, at]);
    return rowCount ?? 0;
  },

  /** Reinstatement restores the assignments its suspension or removal silenced, in their prior state. */
  async restoreForMembership(db: Queryable, membershipId: string): Promise<number> {
    const { rowCount } = await db.query(
      `update iam.role_assignments ra set silenced_at = null
       from iam.memberships m
       where m.organisation_id = ra.organisation_id and m.id = ra.membership_id and ra.membership_id = $1
         and ra.revoked_at is null and ra.silenced_at in (m.suspended_at, m.removed_at)`, [membershipId]);
    return rowCount ?? 0;
  },

  /**
   * The orphan list (spec 56.8): live assignments whose issuer no longer holds the
   * authority they issued them under (no longer administers the scope acted under, is no
   * longer a super admin, or is no longer an active member). Within these subtree paths
   * only, or every one when null (a super admin's view).
   */
  async orphans(db: Queryable, organisationId: string, withinPaths: readonly string[] | null): Promise<RoleAssignment[]> {
    const columns = roleAssignmentTable.select.split(',').map((c) => `ra.${c.trim()}`).join(', ');
    const { rows } = await db.query(
      `select ${columns}
       from iam.role_assignments ra
       join iam.memberships issuer on issuer.organisation_id = ra.organisation_id and issuer.id = ra.granted_by
       left join iam.scopes acted on acted.organisation_id = ra.organisation_id and acted.id = ra.granted_at_scope_id
       where ra.organisation_id = $1 and ra.revoked_at is null and ra.granted_by <> ra.membership_id
         and (issuer.status <> 'active'
              or (not iam.is_super_admin($1, ra.granted_by)
                  and (ra.granted_at_scope_id is null or not exists (
                    select 1 from iam.roles_applying_at($1, ra.granted_by, ra.granted_at_scope_id) r
                    join iam.role_permissions rp on rp.organisation_id = $1 and rp.role_id = r.role_id
                    where rp.permission_id in ('admin.delegate', 'member.invite')))))
         and ($2::text[] is null or (acted.path is not null and exists (
               select 1 from unnest($2::text[]) as within(path) where acted.path <@ within.path::ltree)))
       order by ra.granted_at limit 500`, [organisationId, withinPaths]);
    return rows as RoleAssignment[];
  },

  /**
   * The nearest admin above a scope (spec 55.7): an active membership other than `excluding`
   * holding a live role with admin.delegate on a scope whose path contains it, deepest first.
   */
  async nearestAdminOf(db: Queryable, scopeId: string, excluding: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `select ra.membership_id as "adminId"
       from iam.scopes s
       join iam.role_assignments ra on ra.organisation_id = s.organisation_id and ra.on_scope_id is not null
       join iam.scopes a on a.organisation_id = ra.organisation_id and a.id = ra.on_scope_id and s.path <@ a.path
       join iam.role_permissions rp on rp.organisation_id = ra.organisation_id and rp.role_id = ra.role_id and rp.permission_id = 'admin.delegate'
       join iam.memberships m on m.organisation_id = ra.organisation_id and m.id = ra.membership_id and m.status = 'active'
       where s.id = $1 and ra.membership_id <> $2 and ra.revoked_at is null and ra.silenced_at is null
         and (ra.expires_at is null or ra.expires_at > now())
       order by nlevel(a.path) desc, ra.granted_at, ra.membership_id limit 1`, [scopeId, excluding]);
    return (rows[0] as { adminId: string } | undefined)?.adminId;
  },

  /** A super admin other than `excluding`, active, longest held. */
  async aSuperAdmin(db: Queryable, excluding: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `select ra.membership_id as "adminId" from iam.role_assignments ra
       join iam.roles r on r.organisation_id = ra.organisation_id and r.id = ra.role_id and r.system_role and r.name = 'Super admin'
       join iam.memberships m on m.organisation_id = ra.organisation_id and m.id = ra.membership_id and m.status = 'active'
       where ra.membership_id <> $1 and ra.on_scope_id is null and ra.revoked_at is null and ra.silenced_at is null
         and (ra.expires_at is null or ra.expires_at > now())
       order by ra.granted_at, ra.membership_id limit 1`, [excluding]);
    return (rows[0] as { adminId: string } | undefined)?.adminId;
  },
};

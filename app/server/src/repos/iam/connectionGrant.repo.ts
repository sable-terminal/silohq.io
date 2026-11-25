// Data access for iam.connection_grants, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  connectionGrantTable,
  type ConnectionGrant,
  type ConnectionGrantChanges,
  type NewConnectionGrant,
} from '../../models/iam/connectionGrant.model.ts';

export interface ReachedConnection {
  connectionId: string;
  access: 'read' | 'write';
  expiresAt: string | null;
}

export const connectionGrantRepo = {
  insert(db: Queryable, row: NewConnectionGrant): Promise<ConnectionGrant> {
    return insertRow(db, connectionGrantTable, row);
  },

  findById(db: Queryable, id: ConnectionGrant['id']): Promise<ConnectionGrant | undefined> {
    return findRow(db, connectionGrantTable, { id });
  },

  update(
    db: Queryable,
    id: ConnectionGrant['id'],
    changes: ConnectionGrantChanges,
  ): Promise<ConnectionGrant | undefined> {
    return updateRow(db, connectionGrantTable, { id }, changes);
  },

  /**
   * The connections a membership's live grants reach (spec 57.6 step 3): granted to it,
   * to a role it holds, or to a scope it sits in (its descendants too, unless the grant
   * excludes them). One row per connection with the higher access and the earliest expiry
   * among the grants that give it.
   */
  async reachableByMembership(db: Queryable, membershipId: string): Promise<ReachedConnection[]> {
    const { rows } = await db.query(
      `select g.connection_id as "connectionId", max(g.access) as access, min(g.expires_at) as "expiresAt"
       from iam.connection_grants g
       left join iam.scopes gs on gs.organisation_id = g.organisation_id and gs.id = g.grantee_scope_id
       where g.revoked_at is null and g.silenced_at is null and (g.expires_at is null or g.expires_at > now())
         and (g.grantee_membership_id = $1
              or g.grantee_role_id in (select ra.role_id from iam.role_assignments ra where ra.membership_id = $1 and ra.revoked_at is null and ra.silenced_at is null and (ra.expires_at is null or ra.expires_at > now()))
              or (gs.id is not null and exists (
                select 1 from iam.scope_memberships sm
                join iam.scopes s on s.organisation_id = sm.organisation_id and s.id = sm.scope_id
                where sm.membership_id = $1 and sm.inactive_since is null and s.archived_at is null
                  and (s.id = gs.id or (g.include_descendants and s.path <@ gs.path)))))
       group by g.connection_id`, [membershipId]);
    return rows as ReachedConnection[];
  },

  /** The same for a service principal: granted to it, to a role it holds, or to a scope containing its own. */
  async reachableByPrincipal(db: Queryable, servicePrincipalId: string): Promise<ReachedConnection[]> {
    const { rows } = await db.query(
      `select g.connection_id as "connectionId", max(g.access) as access, min(g.expires_at) as "expiresAt"
       from iam.connection_grants g
       left join iam.scopes gs on gs.organisation_id = g.organisation_id and gs.id = g.grantee_scope_id
       where g.revoked_at is null and g.silenced_at is null and (g.expires_at is null or g.expires_at > now())
         and (g.grantee_service_principal_id = $1
              or g.grantee_role_id in (select spr.role_id from iam.service_principal_roles spr where spr.service_principal_id = $1)
              or (gs.id is not null and exists (
                select 1 from iam.service_principals sp
                join iam.scopes s on s.organisation_id = sp.organisation_id and s.id = sp.scope_id
                where sp.id = $1 and (s.id = gs.id or (g.include_descendants and s.path <@ gs.path)))))
       group by g.connection_id`, [servicePrincipalId]);
    return rows as ReachedConnection[];
  },

  /** Why the database would refuse this grant (spec 56.7, rule 6 included), or null when it would accept it. */
  async refusal(db: Queryable, grant: Pick<NewConnectionGrant, 'organisationId' | 'grantedBy' | 'connectionId' | 'access'>
    & { granteeMembershipId: string | null; granteeScopeId: string | null; granteeRoleId: string | null;
         granteeServicePrincipalId: string | null; grantedAtScopeId: string | null }): Promise<string | null> {
    const { rows } = await db.query('select iam.check_connection_grant($1, $2, $3, $4, $5, $6, $7, $8, $9) as refusal', [
      grant.organisationId, grant.grantedBy, grant.connectionId, grant.granteeMembershipId, grant.granteeScopeId, grant.granteeRoleId,
      grant.granteeServicePrincipalId, grant.access, grant.grantedAtScopeId]);
    return (rows[0] as { refusal: string | null }).refusal;
  },

  /**
   * The scope a granter grants a connection from, for granted_at_scope_id: the nearest
   * scope at or above the target where connection.grant applies to them; failing that,
   * the connection's owning scope when they own the connection and the target is within it.
   */
  async actingScope(db: Queryable, granter: string, connectionId: string, targetScopeId: string): Promise<string | null> {
    const { rows } = await db.query(
      `select coalesce(
         (select held.id
          from iam.role_assignments ra
          join iam.scopes held on held.organisation_id = ra.organisation_id and held.id = ra.on_scope_id
          join iam.scopes target on target.organisation_id = ra.organisation_id and target.id = $3
          join iam.role_permissions rp on rp.organisation_id = ra.organisation_id and rp.role_id = ra.role_id
          where ra.membership_id = $1 and ra.revoked_at is null and ra.silenced_at is null and (ra.expires_at is null or ra.expires_at > now()) and rp.permission_id = 'connection.grant' and target.path <@ held.path
          order by nlevel(held.path) desc limit 1),
         (select c.owning_scope_id
          from connect.connections c
          join iam.scopes owning on owning.organisation_id = c.organisation_id and owning.id = c.owning_scope_id
          join iam.scopes target on target.organisation_id = c.organisation_id and target.id = $3
          where c.id = $2 and c.owning_membership_id = $1 and target.path <@ owning.path)) as scope`,
      [granter, connectionId, targetScopeId]);
    return (rows[0] as { scope: string | null }).scope;
  },

  /** The grants on a connection, live first. */
  async listForConnection(db: Queryable, connectionId: string, includeEnded: boolean): Promise<ConnectionGrant[]> {
    const { rows } = await db.query(
      `select ${connectionGrantTable.select} from iam.connection_grants
       where connection_id = $1 and ($2 or revoked_at is null) order by revoked_at nulls first, granted_at desc limit 500`,
      [connectionId, includeEnded]);
    return rows as ConnectionGrant[];
  },

  /** Suspension and removal silence a membership's own grants without revoking them (spec 55.7). */
  async silenceForMembership(db: Queryable, membershipId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      `update iam.connection_grants set silenced_at = $2
       where grantee_membership_id = $1 and revoked_at is null and silenced_at is null`, [membershipId, at]);
    return rowCount ?? 0;
  },

  async restoreForMembership(db: Queryable, membershipId: string): Promise<number> {
    const { rowCount } = await db.query(
      `update iam.connection_grants g set silenced_at = null
       from iam.memberships m
       where m.organisation_id = g.organisation_id and m.id = g.grantee_membership_id and g.grantee_membership_id = $1
         and g.revoked_at is null and g.silenced_at in (m.suspended_at, m.removed_at)`, [membershipId]);
    return rowCount ?? 0;
  },

  /** Which of these connections the membership owns (and are not revoked): owning one reaches it (spec 56.6). */
  async ownedAmong(db: Queryable, membershipId: string, connectionIds: readonly string[]): Promise<string[]> {
    if (connectionIds.length === 0) return [];
    const { rows } = await db.query(
      `select id from connect.connections where id = any($1::uuid[]) and owning_membership_id = $2 and status <> 'revoked'`,
      [connectionIds, membershipId]);
    return rows.map((row) => (row as { id: string }).id);
  },

  /** Every live connection a member owns: an AI FDE principal reaches these as its engaging administrator does (spec 52.1). */
  async ownedBy(db: Queryable, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select id from connect.connections where owning_membership_id = $1 and status <> 'revoked'`, [membershipId]);
    return rows.map((row) => (row as { id: string }).id);
  },

  /** What a grant decision needs to know of a connection: who owns it and where. */
  async connectionFacts(db: Queryable, connectionId: string)
    : Promise<{ owningScopeId: string; owningMembershipId: string; status: string } | undefined> {
    const { rows } = await db.query(
      `select owning_scope_id as "owningScopeId", owning_membership_id as "owningMembershipId", status
       from connect.connections where id = $1`, [connectionId]);
    return rows[0] as { owningScopeId: string; owningMembershipId: string; status: string } | undefined;
  },
};

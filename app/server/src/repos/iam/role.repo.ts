// Data access for iam.roles, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { roleTable, type NewRole, type Role, type RoleChanges } from '../../models/iam/role.model.ts';

export interface RoleWithPermissions {
  id: string;
  name: string;
  systemRole: boolean;
  retiredAt: string | null;
  version: number;
  permissions: string[];
  grantableRoleIds: string[];
}

export const roleRepo = {
  insert(db: Queryable, row: NewRole): Promise<Role> {
    return insertRow(db, roleTable, row);
  },

  findById(db: Queryable, id: Role['id']): Promise<Role | undefined> {
    return findRow(db, roleTable, { id });
  },

  findByName(db: Queryable, key: Pick<Role, 'organisationId' | 'name'>): Promise<Role | undefined> {
    return findRow(db, roleTable, key);
  },

  update(db: Queryable, id: Role['id'], changes: RoleChanges): Promise<Role | undefined> {
    return updateRow(db, roleTable, { id }, changes);
  },

  /** Every role with its permissions and the roles it may assign (spec 56.7 rule 5). */
  async listWithPermissions(db: Queryable): Promise<RoleWithPermissions[]> {
    const { rows } = await db.query(
      `select r.id, r.name, r.system_role as "systemRole", r.retired_at as "retiredAt", r.version,
              coalesce((select array_agg(rp.permission_id order by rp.permission_id) from iam.role_permissions rp
                        where rp.organisation_id = r.organisation_id and rp.role_id = r.id), '{}') as permissions,
              coalesce((select array_agg(g.grantable_role_id order by g.grantable_role_id) from iam.role_grantable_roles g
                        where g.organisation_id = r.organisation_id and g.granting_role_id = r.id), '{}') as "grantableRoleIds"
       from iam.roles r order by r.system_role desc, r.name`);
    return rows as RoleWithPermissions[];
  },

  async hasLiveAssignments(db: Queryable, roleId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from iam.role_assignments where role_id = $1 and revoked_at is null)
           or exists (select 1 from iam.service_principal_roles where role_id = $1) as yes`, [roleId]);
    return (rows[0] as { yes: boolean }).yes;
  },
};

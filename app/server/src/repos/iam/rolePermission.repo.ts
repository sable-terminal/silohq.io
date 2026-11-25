// Data access for iam.role_permissions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  rolePermissionTable,
  type NewRolePermission,
  type RolePermission,
  type RolePermissionPrimaryKey,
} from '../../models/iam/rolePermission.model.ts';

export const rolePermissionRepo = {
  insert(db: Queryable, row: NewRolePermission): Promise<RolePermission> {
    return insertRow(db, rolePermissionTable, row);
  },

  findByKey(db: Queryable, key: RolePermissionPrimaryKey): Promise<RolePermission | undefined> {
    return findRow(db, rolePermissionTable, key);
  },

  remove(db: Queryable, key: RolePermissionPrimaryKey): Promise<boolean> {
    return deleteRow(db, rolePermissionTable, key);
  },

  /**
   * Makes a role's permissions exactly this set: removes the rest and adds the missing,
   * each row through the catalogue guard. Returns how many were added and removed.
   */
  async replace(db: Queryable, organisationId: string, roleId: string, permissions: readonly string[])
    : Promise<{ added: number; removed: number }> {
    const removed = await db.query(
      'delete from iam.role_permissions where role_id = $1 and not (permission_id = any($2::text[]))', [roleId, permissions]);
    const added = await db.query(
      `insert into iam.role_permissions (organisation_id, role_id, permission_id)
       select $1, $2, p from unnest($3::text[]) as p on conflict do nothing`, [organisationId, roleId, permissions]);
    return { added: added.rowCount ?? 0, removed: removed.rowCount ?? 0 };
  },
};

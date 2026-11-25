// Data access for iam.role_grantable_roles, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  roleGrantableRoleTable,
  type NewRoleGrantableRole,
  type RoleGrantableRole,
  type RoleGrantableRolePrimaryKey,
} from '../../models/iam/roleGrantableRole.model.ts';

export const roleGrantableRoleRepo = {
  insert(db: Queryable, row: NewRoleGrantableRole): Promise<RoleGrantableRole> {
    return insertRow(db, roleGrantableRoleTable, row);
  },

  findByKey(db: Queryable, key: RoleGrantableRolePrimaryKey): Promise<RoleGrantableRole | undefined> {
    return findRow(db, roleGrantableRoleTable, key);
  },

  remove(db: Queryable, key: RoleGrantableRolePrimaryKey): Promise<boolean> {
    return deleteRow(db, roleGrantableRoleTable, key);
  },
};

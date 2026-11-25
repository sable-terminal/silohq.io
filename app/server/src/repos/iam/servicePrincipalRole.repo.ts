// Data access for iam.service_principal_roles, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  servicePrincipalRoleTable,
  type NewServicePrincipalRole,
  type ServicePrincipalRole,
  type ServicePrincipalRolePrimaryKey,
} from '../../models/iam/servicePrincipalRole.model.ts';

export const servicePrincipalRoleRepo = {
  insert(db: Queryable, row: NewServicePrincipalRole): Promise<ServicePrincipalRole> {
    return insertRow(db, servicePrincipalRoleTable, row);
  },

  findByKey(db: Queryable, key: ServicePrincipalRolePrimaryKey): Promise<ServicePrincipalRole | undefined> {
    return findRow(db, servicePrincipalRoleTable, key);
  },

  remove(db: Queryable, key: ServicePrincipalRolePrimaryKey): Promise<boolean> {
    return deleteRow(db, servicePrincipalRoleTable, key);
  },

  /** A principal's roles with their permissions (spec 60.4). */
  async grantsFor(db: Queryable, servicePrincipalId: string): Promise<{ roleId: string; permissions: string[] }[]> {
    const { rows } = await db.query(
      `select spr.role_id as "roleId",
              coalesce(array_agg(rp.permission_id order by rp.permission_id) filter (where rp.permission_id is not null), '{}') as permissions
       from iam.service_principal_roles spr
       join iam.roles r on r.organisation_id = spr.organisation_id and r.id = spr.role_id and r.retired_at is null
       left join iam.role_permissions rp on rp.organisation_id = spr.organisation_id and rp.role_id = spr.role_id
       where spr.service_principal_id = $1 group by spr.role_id`, [servicePrincipalId]);
    return rows as { roleId: string; permissions: string[] }[];
  },
};

// Data access for iam.service_principals, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  servicePrincipalTable,
  type NewServicePrincipal,
  type ServicePrincipal,
  type ServicePrincipalChanges,
} from '../../models/iam/servicePrincipal.model.ts';

export const servicePrincipalRepo = {
  insert(db: Queryable, row: NewServicePrincipal): Promise<ServicePrincipal> {
    return insertRow(db, servicePrincipalTable, row);
  },

  findById(db: Queryable, id: ServicePrincipal['id']): Promise<ServicePrincipal | undefined> {
    return findRow(db, servicePrincipalTable, { id });
  },

  update(
    db: Queryable,
    id: ServicePrincipal['id'],
    changes: ServicePrincipalChanges,
  ): Promise<ServicePrincipal | undefined> {
    return updateRow(db, servicePrincipalTable, { id }, changes);
  },

  async list(db: Queryable, includeRevoked: boolean): Promise<ServicePrincipal[]> {
    const { rows } = await db.query(
      `select ${servicePrincipalTable.select} from iam.service_principals where ($1 or revoked_at is null) order by created_at`,
      [includeRevoked]);
    return rows as ServicePrincipal[];
  },

  /** A principal with its bounding scope's path, for a decision. */
  async findForDecision(db: Queryable, id: string): Promise<(ServicePrincipal & { scopePath: string | null }) | undefined> {
    const columns = servicePrincipalTable.select.split(',').map((c) => `sp.${c.trim()}`).join(', ');
    const { rows } = await db.query(
      `select ${columns}, s.path::text as "scopePath" from iam.service_principals sp
       left join iam.scopes s on s.organisation_id = sp.organisation_id and s.id = sp.scope_id where sp.id = $1`, [id]);
    return rows[0] as (ServicePrincipal & { scopePath: string | null }) | undefined;
  },
};

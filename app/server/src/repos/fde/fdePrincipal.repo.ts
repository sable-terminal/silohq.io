// Data access for fde.fde_principals, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fdePrincipalTable,
  type FdePrincipal,
  type FdePrincipalChanges,
  type NewFdePrincipal,
} from '../../models/fde/fdePrincipal.model.ts';

export const fdePrincipalRepo = {
  insert(db: Queryable, row: NewFdePrincipal): Promise<FdePrincipal> {
    return insertRow(db, fdePrincipalTable, row);
  },

  findById(db: Queryable, id: FdePrincipal['id']): Promise<FdePrincipal | undefined> {
    return findRow(db, fdePrincipalTable, { id });
  },

  findByServicePrincipalId(
    db: Queryable,
    key: Pick<FdePrincipal, 'organisationId' | 'servicePrincipalId'>,
  ): Promise<FdePrincipal | undefined> {
    return findRow(db, fdePrincipalTable, key);
  },

  update(
    db: Queryable,
    id: FdePrincipal['id'],
    changes: FdePrincipalChanges,
  ): Promise<FdePrincipal | undefined> {
    return updateRow(db, fdePrincipalTable, { id }, changes);
  },

  async listForEngagement(db: Queryable, engagementId: string): Promise<FdePrincipal[]> {
    const { rows } = await db.query(
      `select ${fdePrincipalTable.select} from fde.fde_principals where engagement_id = $1 order by created_at, role`, [engagementId]);
    return rows as FdePrincipal[];
  },

  async liveForRole(db: Queryable, engagementId: string, role: FdePrincipal['role']): Promise<FdePrincipal | undefined> {
    const { rows } = await db.query(
      `select ${fdePrincipalTable.select} from fde.fde_principals where engagement_id = $1 and role = $2 and revoked_at is null`,
      [engagementId, role]);
    return rows[0] as FdePrincipal | undefined;
  },
};

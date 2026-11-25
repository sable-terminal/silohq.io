// Data access for gov.clearances, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  clearanceTable,
  type Clearance,
  type ClearanceChanges,
  type NewClearance,
} from '../../models/gov/clearance.model.ts';

export const clearanceRepo = {
  insert(db: Queryable, row: NewClearance): Promise<Clearance> {
    return insertRow(db, clearanceTable, row);
  },

  findById(db: Queryable, id: Clearance['id']): Promise<Clearance | undefined> {
    return findRow(db, clearanceTable, { id });
  },

  update(db: Queryable, id: Clearance['id'], changes: ClearanceChanges): Promise<Clearance | undefined> {
    return updateRow(db, clearanceTable, { id }, changes);
  },

  /** The markings a membership's or principal's live clearances satisfy, with when each ends (spec 58.2). */
  async liveFor(db: Queryable, holder: { membershipId: string } | { servicePrincipalId: string })
    : Promise<{ markingId: string; expiresAt: string | null }[]> {
    const membership = 'membershipId' in holder;
    const { rows } = await db.query(
      `select marking_id as "markingId", expires_at as "expiresAt" from gov.clearances
       where ${membership ? 'membership_id' : 'service_principal_id'} = $1
         and revoked_at is null and (expires_at is null or expires_at > now())`,
      [membership ? holder.membershipId : holder.servicePrincipalId]);
    return rows as { markingId: string; expiresAt: string | null }[];
  },

  async list(db: Queryable, filter: { membershipId?: string | undefined; markingId?: string | undefined }): Promise<Clearance[]> {
    const { rows } = await db.query(
      `select ${clearanceTable.select} from gov.clearances
       where revoked_at is null and ($1::uuid is null or membership_id = $1) and ($2::uuid is null or marking_id = $2)
       order by granted_at desc limit 500`, [filter.membershipId ?? null, filter.markingId ?? null]);
    return rows as Clearance[];
  },
};

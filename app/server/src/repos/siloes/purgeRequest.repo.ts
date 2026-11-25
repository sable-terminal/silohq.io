// Data access for siloes.purge_requests, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  purgeRequestTable,
  type NewPurgeRequest,
  type PurgeRequest,
  type PurgeRequestChanges,
} from '../../models/siloes/purgeRequest.model.ts';

export const purgeRequestRepo = {
  insert(db: Queryable, row: NewPurgeRequest): Promise<PurgeRequest> {
    return insertRow(db, purgeRequestTable, row);
  },

  findById(db: Queryable, id: PurgeRequest['id']): Promise<PurgeRequest | undefined> {
    return findRow(db, purgeRequestTable, { id });
  },

  update(
    db: Queryable,
    id: PurgeRequest['id'],
    changes: PurgeRequestChanges,
  ): Promise<PurgeRequest | undefined> {
    return updateRow(db, purgeRequestTable, { id }, changes);
  },

  /** A Silo's purges, newest first, each with whether its receipt is written. */
  async listForSilo(db: Queryable, siloId: string, limit: number): Promise<(PurgeRequest & { hasReceipt: boolean })[]> {
    const { rows } = await db.query(
      `select ${purgeRequestTable.select.split(', ').map((c) => `p.${c}`).join(', ')},
              exists (select 1 from siloes.purge_receipts r where r.purge_request_id = p.id) as "hasReceipt"
         from siloes.purge_requests p where p.silo_id = $1 order by p.requested_at desc, p.id desc limit $2`, [siloId, limit]);
    return rows as (PurgeRequest & { hasReceipt: boolean })[];
  },

  /** Purges awaiting approval or approved, across the cell: identifiers only. */
  async listOpen(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from siloes.open_purge_requests($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },
};

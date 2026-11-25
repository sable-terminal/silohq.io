// Data access for action.actuation_allowlist_requests, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  actuationAllowlistRequestTable,
  type ActuationAllowlistRequest,
  type ActuationAllowlistRequestChanges,
  type NewActuationAllowlistRequest,
} from '../../models/action/actuationAllowlistRequest.model.ts';

export const actuationAllowlistRequestRepo = {
  insert(db: Queryable, row: NewActuationAllowlistRequest): Promise<ActuationAllowlistRequest> {
    return insertRow(db, actuationAllowlistRequestTable, row);
  },

  findById(
    db: Queryable,
    id: ActuationAllowlistRequest['id'],
  ): Promise<ActuationAllowlistRequest | undefined> {
    return findRow(db, actuationAllowlistRequestTable, { id });
  },

  update(
    db: Queryable,
    id: ActuationAllowlistRequest['id'],
    changes: ActuationAllowlistRequestChanges,
  ): Promise<ActuationAllowlistRequest | undefined> {
    return updateRow(db, actuationAllowlistRequestTable, { id }, changes);
  },

  /** Decides a pending request; undefined if it was decided already. */
  async decide(db: Queryable, id: string, d: { status: 'approved' | 'rejected'; decidedBy: string; decidedAt: string; entryId: string | null }):
    Promise<ActuationAllowlistRequest | undefined> {
    const { rows } = await db.query(
      `update action.actuation_allowlist_requests set status = $2, decided_by = $3, decided_at = $4, entry_id = $5
        where id = $1 and status = 'pending' returning ${actuationAllowlistRequestTable.select}`, [id, d.status, d.decidedBy, d.decidedAt, d.entryId]);
    return rows[0] as ActuationAllowlistRequest | undefined;
  },

  /** A connection's requests waiting for their second person, oldest first. */
  async pendingForConnection(db: Queryable, connectionId: string): Promise<ActuationAllowlistRequest[]> {
    const { rows } = await db.query(
      `select ${actuationAllowlistRequestTable.select} from action.actuation_allowlist_requests
        where connection_id = $1 and status = 'pending' order by created_at, id`, [connectionId]);
    return rows as ActuationAllowlistRequest[];
  },
};

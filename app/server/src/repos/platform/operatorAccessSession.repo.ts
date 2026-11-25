// Data access for platform.operator_access_sessions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by admin-portal (staff steps, the customer's decision).
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  operatorAccessSessionTable,
  type NewOperatorAccessSession,
  type OperatorAccessSession,
  type OperatorAccessSessionChanges,
} from '../../models/platform/operatorAccessSession.model.ts';

export const operatorAccessSessionRepo = {
  findById(db: Queryable, id: OperatorAccessSession['id']): Promise<OperatorAccessSession | undefined> {
    return findRow(db, operatorAccessSessionTable, { id });
  },

  /** The row locked for a change of status. */
  async lock(db: Queryable, id: string): Promise<OperatorAccessSession | undefined> {
    const { rows } = await db.query(
      `select ${operatorAccessSessionTable.select} from ${operatorAccessSessionTable.sql} where id = $1 for update`, [id]);
    return rows[0] as OperatorAccessSession | undefined;
  },

  /**
   * The session if it is running now on this organisation: active and not past its
   * expiry (the sweep may not have run yet). What a service checks before serving a
   * request admin-portal makes under break-glass.
   */
  async findLive(db: Queryable, id: string, organisationId: string): Promise<OperatorAccessSession | undefined> {
    const { rows } = await db.query(
      `select ${operatorAccessSessionTable.select} from ${operatorAccessSessionTable.sql}
       where id = $1 and organisation_id = $2 and status = 'active' and expires_at > now()`, [id, organisationId]);
    return rows[0] as OperatorAccessSession | undefined;
  },

  insert(db: Queryable, row: NewOperatorAccessSession): Promise<OperatorAccessSession> {
    return insertRow(db, operatorAccessSessionTable, row);
  },

  update(db: Queryable, id: string, changes: OperatorAccessSessionChanges): Promise<OperatorAccessSession | undefined> {
    return updateRow(db, operatorAccessSessionTable, { id }, changes);
  },

  /** One more resource touched under a running session; undefined when it is no longer running. */
  async touch(db: Queryable, id: string): Promise<OperatorAccessSession | undefined> {
    const { rows } = await db.query(
      `update ${operatorAccessSessionTable.sql} set resources_touched_count = resources_touched_count + 1
       where id = $1 and status = 'active' and expires_at > now() returning ${operatorAccessSessionTable.select}`, [id]);
    return rows[0] as OperatorAccessSession | undefined;
  },

  /** The organisation's sessions, newest first, before the given (requested_at, id). */
  async listForOrganisation(db: Queryable, options: {
    status?: OperatorAccessSession['status'] | undefined; before?: { requestedAt: string; id: string } | undefined; limit: number;
  }): Promise<OperatorAccessSession[]> {
    const { rows } = await db.query(
      `select ${operatorAccessSessionTable.select} from ${operatorAccessSessionTable.sql}
       where ($1::text is null or status = $1)
         and ($2::timestamptz is null or (requested_at, id) < ($2::timestamptz, $3::uuid))
       order by requested_at desc, id desc limit $4`,
      [options.status ?? null, options.before?.requestedAt ?? null, options.before?.id ?? null, options.limit]);
    return rows as OperatorAccessSession[];
  },

  /** Requested, approved and active sessions across organisations, identifiers only (security definer). */
  async openAcrossOrganisations(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", id from platform.operator_access_sessions_open($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** Active sessions past their expiry, across organisations, identifiers only (security definer). */
  async dueAcrossOrganisations(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", id from platform.operator_access_sessions_due($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },
};

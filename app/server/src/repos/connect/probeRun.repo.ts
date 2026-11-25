// Data access for connect.probe_runs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  probeRunTable,
  type NewProbeRun,
  type ProbeRun,
  type ProbeRunChanges,
} from '../../models/connect/probeRun.model.ts';

export const probeRunRepo = {
  insert(db: Queryable, row: NewProbeRun): Promise<ProbeRun> {
    return insertRow(db, probeRunTable, row);
  },

  findById(db: Queryable, id: ProbeRun['id']): Promise<ProbeRun | undefined> {
    return findRow(db, probeRunTable, { id });
  },

  update(db: Queryable, id: ProbeRun['id'], changes: ProbeRunChanges): Promise<ProbeRun | undefined> {
    return updateRow(db, probeRunTable, { id }, changes);
  },

  /** A connection's re-checks (stage recheck), newest first (connector-maintenance). */
  async listRechecks(db: Queryable, connectionId: string, limit: number): Promise<ProbeRun[]> {
    const { rows } = await db.query(
      `select ${probeRunTable.select} from connect.probe_runs
       where connection_id = $1 and stage = 'recheck' order by started_at desc, id desc limit $2`, [connectionId, limit]);
    return rows as ProbeRun[];
  },

  /** The newest completed re-check: the baseline a rename is judged against. */
  async latestCompletedRecheck(db: Queryable, connectionId: string): Promise<ProbeRun | undefined> {
    const { rows } = await db.query(
      `select ${probeRunTable.select} from connect.probe_runs
       where connection_id = $1 and stage = 'recheck' and status = 'completed' order by started_at desc, id desc limit 1`, [connectionId]);
    return rows[0] as ProbeRun | undefined;
  },

  /**
   * Active connections whose last re-check is older than the interval, oldest health first,
   * across organisations: identifiers only, through a definer function (the weekly re-check).
   */
  async dueForRecheck(db: Queryable, intervalSeconds: number, limit: number): Promise<{ organisationId: string; connectionId: string }[]> {
    const { rows } = await db.query(
      `select organisation_id as "organisationId", connection_id as "connectionId"
       from connect.connections_due_for_recheck(make_interval(secs => $1), $2)`, [intervalSeconds, limit]);
    return rows as { organisationId: string; connectionId: string }[];
  },

  /** A connection's build stages, oldest first, the latest `limit` of them (the build routes). */
  async listForConnection(db: Queryable, connectionId: string, limit: number): Promise<ProbeRun[]> {
    const { rows } = await db.query(
      `select * from (select ${probeRunTable.select} from connect.probe_runs
         where connection_id = $1 and stage <> 'recheck' order by started_at desc, id desc limit $2) recent
       order by "startedAt", id`, [connectionId, limit]);
    return rows as ProbeRun[];
  },
};

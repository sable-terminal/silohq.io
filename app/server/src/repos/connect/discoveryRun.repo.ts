// Data access for connect.discovery_runs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  discoveryRunTable,
  type DiscoveryRun,
  type DiscoveryRunChanges,
  type NewDiscoveryRun,
} from '../../models/connect/discoveryRun.model.ts';

export const discoveryRunRepo = {
  insert(db: Queryable, row: NewDiscoveryRun): Promise<DiscoveryRun> {
    return insertRow(db, discoveryRunTable, row);
  },

  findById(db: Queryable, id: DiscoveryRun['id']): Promise<DiscoveryRun | undefined> {
    return findRow(db, discoveryRunTable, { id });
  },

  update(
    db: Queryable,
    id: DiscoveryRun['id'],
    changes: DiscoveryRunChanges,
  ): Promise<DiscoveryRun | undefined> {
    return updateRow(db, discoveryRunTable, { id }, changes);
  },

  /** A run, locked for the rest of the transaction: its reports are taken one at a time. */
  async lock(db: Queryable, id: string): Promise<DiscoveryRun | undefined> {
    const { rows } = await db.query(`select ${discoveryRunTable.select} from connect.discovery_runs where id = $1 for update`, [id]);
    return rows[0] as DiscoveryRun | undefined;
  },

  /** Runs of an organisation still running: switched off, they stop. */
  async listRunningIn(db: Queryable): Promise<DiscoveryRun[]> {
    const { rows } = await db.query(`select ${discoveryRunTable.select} from connect.discovery_runs where status = 'running'`);
    return rows as DiscoveryRun[];
  },

  /** Running runs silent since before, across organisations (connect.discovery_runs_silent). */
  async silent(db: Queryable, before: string, limit: number): Promise<{ organisationId: string; runId: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", run_id as "runId" from connect.discovery_runs_silent($1::timestamptz, $2)', [before, limit]);
    return rows as { organisationId: string; runId: string }[];
  },

  /** Runs of an authorisation still running. */
  async listRunning(db: Queryable, authorisationId: string): Promise<DiscoveryRun[]> {
    const { rows } = await db.query(
      `select ${discoveryRunTable.select} from connect.discovery_runs where authorisation_id = $1 and status = 'running'`, [authorisationId]);
    return rows as DiscoveryRun[];
  },

  /** An authorisation's runs, newest first. */
  async listForAuthorisation(db: Queryable, authorisationId: string, limit: number): Promise<DiscoveryRun[]> {
    const { rows } = await db.query(
      `select ${discoveryRunTable.select} from connect.discovery_runs where authorisation_id = $1 order by started_at desc, id desc limit $2`, [authorisationId, limit]);
    return rows as DiscoveryRun[];
  },

  /** The probes logged and the findings raised by a run. */
  async counts(db: Queryable, runId: string): Promise<{ probes: number; findings: number }> {
    const { rows } = await db.query(
      `select (select count(*)::int from connect.discovery_probes where run_id = $1) as probes,
              (select count(*)::int from connect.discovery_findings where run_id = $1) as findings`, [runId]);
    return rows[0] as { probes: number; findings: number };
  },
};

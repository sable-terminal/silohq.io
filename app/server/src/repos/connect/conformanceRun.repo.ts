// Data access for connect.conformance_runs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  conformanceRunTable,
  type ConformanceRun,
  type ConformanceRunChanges,
  type NewConformanceRun,
} from '../../models/connect/conformanceRun.model.ts';

export const conformanceRunRepo = {
  insert(db: Queryable, row: NewConformanceRun): Promise<ConformanceRun> {
    return insertRow(db, conformanceRunTable, row);
  },

  findById(db: Queryable, id: ConformanceRun['id']): Promise<ConformanceRun | undefined> {
    return findRow(db, conformanceRunTable, { id });
  },

  update(
    db: Queryable,
    id: ConformanceRun['id'],
    changes: ConformanceRunChanges,
  ): Promise<ConformanceRun | undefined> {
    return updateRow(db, conformanceRunTable, { id }, changes);
  },

  /** The newest completed run of a connection on one manifest version: what the gate and the runtime read. */
  async latestCompleted(db: Queryable, connectionId: string, manifestId: string): Promise<ConformanceRun | undefined> {
    const { rows } = await db.query(
      `select ${conformanceRunTable.select} from connect.conformance_runs
       where connection_id = $1 and manifest_id = $2 and completed_at is not null
         -- Runs of the read suite: a write-verify-undo run (write-back) gates writes, not reads.
         and classes_run && array['read', 'pagination', 'filter_pushdown', 'error']::text[]
       order by started_at desc, id desc limit 1`, [connectionId, manifestId]);
    return rows[0] as ConformanceRun | undefined;
  },

  /** Runs of a connection still without a completion, oldest first. */
  async listOpen(db: Queryable, connectionId: string): Promise<ConformanceRun[]> {
    const { rows } = await db.query(
      `select ${conformanceRunTable.select} from connect.conformance_runs
       where connection_id = $1 and completed_at is null order by started_at, id`, [connectionId]);
    return rows as ConformanceRun[];
  },

  /** Completed runs on a manifest version, newest first: this organisation's, or every one for the migration role. */
  async listCompletedForManifest(db: Queryable, manifestId: string, limit: number): Promise<ConformanceRun[]> {
    const { rows } = await db.query(
      `select ${conformanceRunTable.select} from connect.conformance_runs
       where manifest_id = $1 and completed_at is not null order by started_at desc, id desc limit $2`, [manifestId, limit]);
    return rows as ConformanceRun[];
  },

  /** Newest first. */
  async listForConnection(db: Queryable, connectionId: string, limit: number): Promise<ConformanceRun[]> {
    const { rows } = await db.query(
      `select ${conformanceRunTable.select} from connect.conformance_runs
       where connection_id = $1 order by started_at desc, id desc limit $2`, [connectionId, limit]);
    return rows as ConformanceRun[];
  },

  /** Completed change-stream class runs on a manifest version, newest first (decision 2026-11-15: they make a stream subscribable). */
  async changeStreamRuns(db: Queryable, connectionId: string, manifestId: string, limit: number): Promise<ConformanceRun[]> {
    const { rows } = await db.query(
      `select ${conformanceRunTable.select} from connect.conformance_runs
       where connection_id = $1 and manifest_id = $2 and completed_at is not null and 'change_stream' = any (classes_run)
       order by started_at desc, id desc limit $3`, [connectionId, manifestId, limit]);
    return rows as ConformanceRun[];
  },

  /** The latest completed write-verify-undo run on a manifest version (spec 17.1: it earns writes). */
  async latestWriteClass(db: Queryable, connectionId: string, manifestId: string): Promise<ConformanceRun | undefined> {
    const { rows } = await db.query(
      `select ${conformanceRunTable.select} from connect.conformance_runs
       where connection_id = $1 and manifest_id = $2 and completed_at is not null and 'write_verify_undo' = any (classes_run)
       order by started_at desc, id desc limit 1`, [connectionId, manifestId]);
    return rows[0] as ConformanceRun | undefined;
  },
};

// Data access for fde.fde_tasks, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fdeTaskTable,
  type FdeTask,
  type FdeTaskChanges,
  type NewFdeTask,
} from '../../models/fde/fdeTask.model.ts';

export const fdeTaskRepo = {
  insert(db: Queryable, row: NewFdeTask): Promise<FdeTask> {
    return insertRow(db, fdeTaskTable, row);
  },

  findById(db: Queryable, id: FdeTask['id']): Promise<FdeTask | undefined> {
    return findRow(db, fdeTaskTable, { id });
  },

  update(db: Queryable, id: FdeTask['id'], changes: FdeTaskChanges): Promise<FdeTask | undefined> {
    return updateRow(db, fdeTaskTable, { id }, changes);
  },

  /**
   * The task's provider token counts, recomputed from the model call ledger (spec 52.6):
   * every call model-gateway made for the task, so a usage message redelivered or out of
   * order changes nothing. Thinking tokens are billed as output. Undefined if no such task.
   */
  async recomputeProviderTokens(db: Queryable, organisationId: FdeTask['organisationId'], id: FdeTask['id']): Promise<FdeTask | undefined> {
    const { rows } = await db.query(
      `update fde.fde_tasks t
          set provider_input_tokens = u.input_tokens, provider_output_tokens = u.output_tokens
         from (select coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens + thinking_tokens), 0) as output_tokens
                 from platform.model_calls where organisation_id = $1 and task_id = $2) u
        where t.organisation_id = $1 and t.id = $2
        returning ${fdeTaskTable.select.split(', ').map((column) => `t.${column}`).join(', ')}`,
      [organisationId, id]);
    return rows[0] as FdeTask | undefined;
  },

  async listForEngagement(db: Queryable, engagementId: string, limit = 500): Promise<FdeTask[]> {
    const { rows } = await db.query(
      `select ${fdeTaskTable.select} from fde.fde_tasks where engagement_id = $1 order by created_at desc limit $2`, [engagementId, limit]);
    return rows as FdeTask[];
  },

  async listForStage(db: Queryable, stageId: string): Promise<FdeTask[]> {
    const { rows } = await db.query(`select ${fdeTaskTable.select} from fde.fde_tasks where stage_id = $1 order by created_at`, [stageId]);
    return rows as FdeTask[];
  },

  /** Tasks waiting or running for an engagement, oldest first (fde_tasks_runnable). */
  async runnable(db: Queryable, engagementId: string): Promise<FdeTask[]> {
    const { rows } = await db.query(
      `select ${fdeTaskTable.select} from fde.fde_tasks where engagement_id = $1 and status in ('queued', 'running') order by created_at`,
      [engagementId]);
    return rows as FdeTask[];
  },

  /** Failed attempts on one system in one stage: three escalate (53.4). */
  async failedFor(db: Queryable, stageId: string, connectionId: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from fde.fde_tasks where stage_id = $1 and connection_id = $2 and status = 'failed'`, [stageId, connectionId]);
    return (rows[0] as { n: number }).n;
  },

  /** Cancels what has not finished (the stop button, 52.7). */
  async cancelOpen(db: Queryable, engagementId: string): Promise<number> {
    const { rowCount } = await db.query(
      `update fde.fde_tasks set status = 'cancelled', completed_at = now() where engagement_id = $1 and status in ('queued', 'running')`,
      [engagementId]);
    return rowCount ?? 0;
  },

  /** Model use in the last minute, for the calls-per-minute limit (52.5). */
  async startedSince(db: Queryable, engagementId: string, since: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from fde.fde_tasks where engagement_id = $1 and started_at >= $2`, [engagementId, since]);
    return (rows[0] as { n: number }).n;
  },
};

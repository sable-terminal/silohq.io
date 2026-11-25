// Data access for workspace.pipeline_schedules, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  pipelineScheduleTable,
  type NewPipelineSchedule,
  type PipelineSchedule,
  type PipelineScheduleChanges,
  type PipelineSchedulePrimaryKey,
} from '../../models/workspace/pipelineSchedule.model.ts';

export const pipelineScheduleRepo = {
  insert(db: Queryable, row: NewPipelineSchedule): Promise<PipelineSchedule> {
    return insertRow(db, pipelineScheduleTable, row);
  },

  findByKey(db: Queryable, key: PipelineSchedulePrimaryKey): Promise<PipelineSchedule | undefined> {
    return findRow(db, pipelineScheduleTable, key);
  },

  findByServicePrincipalId(
    db: Queryable,
    key: Pick<PipelineSchedule, 'organisationId' | 'servicePrincipalId'>,
  ): Promise<PipelineSchedule | undefined> {
    return findRow(db, pipelineScheduleTable, key);
  },

  update(
    db: Queryable,
    key: PipelineSchedulePrimaryKey,
    changes: PipelineScheduleChanges,
  ): Promise<PipelineSchedule | undefined> {
    return updateRow(db, pipelineScheduleTable, key, changes);
  },

  remove(db: Queryable, key: PipelineSchedulePrimaryKey): Promise<boolean> {
    return deleteRow(db, pipelineScheduleTable, key);
  },

  async findForUpdate(db: Queryable, pipelineId: string): Promise<PipelineSchedule | undefined> {
    const { rows } = await db.query(`select ${pipelineScheduleTable.select} from workspace.pipeline_schedules where pipeline_id = $1 for update`, [pipelineId]);
    return rows[0] as PipelineSchedule | undefined;
  },

  async listForPipelines(db: Queryable, pipelineIds: readonly string[]): Promise<PipelineSchedule[]> {
    if (pipelineIds.length === 0) return [];
    const { rows } = await db.query(`select ${pipelineScheduleTable.select} from workspace.pipeline_schedules where pipeline_id = any($1::uuid[])`, [[...pipelineIds]]);
    return rows as PipelineSchedule[];
  },

  /**
   * Claims due schedules across organisations (workspace.claim_due_pipeline_schedules: identifiers
   * only, each leased), for the due sweep.
   */
  async claimDue(db: Queryable, batch: number, now: string): Promise<{ organisationId: string; pipelineId: string; nextRunAt: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", pipeline_id as "pipelineId", next_run_at as "nextRunAt" from workspace.claim_due_pipeline_schedules($1, $2)', [batch, now]);
    return rows as { organisationId: string; pipelineId: string; nextRunAt: string }[];
  },

  /**
   * What a pipeline's principal is granted (policy, D241): the connections its inputs read, while its
   * schedule stands and its pipeline is not archived. Undefined for a principal that is no pipeline's.
   */
  async grantedToPrincipal(db: Queryable, servicePrincipalId: string): Promise<string[] | undefined> {
    const { rows } = await db.query(
      `select s.connection_ids as "connectionIds", p.archived_at is null as live from workspace.pipeline_schedules s
       join workspace.pipelines p on p.organisation_id = s.organisation_id and p.id = s.pipeline_id
       where s.service_principal_id = $1`, [servicePrincipalId]);
    const row = rows[0] as { connectionIds: string[]; live: boolean } | undefined;
    return row === undefined ? undefined : row.live ? row.connectionIds : [];
  },
};

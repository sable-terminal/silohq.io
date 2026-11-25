// Data access for workspace.pipeline_runs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  pipelineRunTable,
  type NewPipelineRun,
  type PipelineRun,
  type PipelineRunChanges,
} from '../../models/workspace/pipelineRun.model.ts';

export const pipelineRunRepo = {
  insert(db: Queryable, row: NewPipelineRun): Promise<PipelineRun> {
    return insertRow(db, pipelineRunTable, row);
  },

  findById(db: Queryable, id: PipelineRun['id']): Promise<PipelineRun | undefined> {
    return findRow(db, pipelineRunTable, { id });
  },

  update(
    db: Queryable,
    id: PipelineRun['id'],
    changes: PipelineRunChanges,
  ): Promise<PipelineRun | undefined> {
    return updateRow(db, pipelineRunTable, { id }, changes);
  },

  /** A pipeline's runs, newest first. */
  async listForPipeline(db: Queryable, pipelineId: string): Promise<PipelineRun[]> {
    const { rows } = await db.query(
      `select ${pipelineRunTable.select} from workspace.pipeline_runs where pipeline_id = $1 order by started_at desc, id desc limit 50`, [pipelineId]);
    return rows as PipelineRun[];
  },
};

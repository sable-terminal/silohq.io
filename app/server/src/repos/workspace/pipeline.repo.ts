// Data access for workspace.pipelines, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  pipelineTable,
  type NewPipeline,
  type Pipeline,
  type PipelineChanges,
} from '../../models/workspace/pipeline.model.ts';

export const pipelineRepo = {
  insert(db: Queryable, row: NewPipeline): Promise<Pipeline> {
    return insertRow(db, pipelineTable, row);
  },

  findById(db: Queryable, id: Pipeline['id']): Promise<Pipeline | undefined> {
    return findRow(db, pipelineTable, { id });
  },

  update(db: Queryable, id: Pipeline['id'], changes: PipelineChanges): Promise<Pipeline | undefined> {
    return updateRow(db, pipelineTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<Pipeline | undefined> {
    const { rows } = await db.query(`select ${pipelineTable.select} from workspace.pipelines where id = $1 for update`, [id]);
    return rows[0] as Pipeline | undefined;
  },

  async listMine(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<Pipeline[]> {
    const { rows } = await db.query(
      `select ${pipelineTable.select} from workspace.pipelines where owner_membership_id = $1 and (archived_at is not null) = $2
       order by updated_at desc limit $3`, [membershipId, archived, limit]);
    return rows as Pipeline[];
  },
};

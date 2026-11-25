// Data access for workspace.process_analyses, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  processAnalysisTable,
  type NewProcessAnalysis,
  type ProcessAnalysis,
  type ProcessAnalysisChanges,
} from '../../models/workspace/processAnalysis.model.ts';

export const processAnalysisRepo = {
  insert(db: Queryable, row: NewProcessAnalysis): Promise<ProcessAnalysis> {
    return insertRow(db, processAnalysisTable, row);
  },

  findById(db: Queryable, id: ProcessAnalysis['id']): Promise<ProcessAnalysis | undefined> {
    return findRow(db, processAnalysisTable, { id });
  },

  update(
    db: Queryable,
    id: ProcessAnalysis['id'],
    changes: ProcessAnalysisChanges,
  ): Promise<ProcessAnalysis | undefined> {
    return updateRow(db, processAnalysisTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<ProcessAnalysis | undefined> {
    const { rows } = await db.query(`select ${processAnalysisTable.select} from workspace.process_analyses where id = $1 for update`, [id]);
    return rows[0] as ProcessAnalysis | undefined;
  },

  async listMine(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<ProcessAnalysis[]> {
    const { rows } = await db.query(
      `select ${processAnalysisTable.select} from workspace.process_analyses where owner_membership_id = $1 and (archived_at is not null) = $2
       order by updated_at desc limit $3`, [membershipId, archived, limit]);
    return rows as ProcessAnalysis[];
  },

  async listByIds(db: Queryable, ids: readonly string[], limit: number): Promise<ProcessAnalysis[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${processAnalysisTable.select} from workspace.process_analyses where id = any($1::uuid[]) and archived_at is null order by updated_at desc limit $2`, [[...ids], limit]);
    return rows as ProcessAnalysis[];
  },
};

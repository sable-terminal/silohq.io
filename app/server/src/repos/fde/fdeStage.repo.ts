// Data access for fde.fde_stages, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fdeStageTable,
  type FdeStage,
  type FdeStageChanges,
  type NewFdeStage,
} from '../../models/fde/fdeStage.model.ts';

export const fdeStageRepo = {
  insert(db: Queryable, row: NewFdeStage): Promise<FdeStage> {
    return insertRow(db, fdeStageTable, row);
  },

  findById(db: Queryable, id: FdeStage['id']): Promise<FdeStage | undefined> {
    return findRow(db, fdeStageTable, { id });
  },

  findByEngagementIdAndStageNumberAndAttempt(
    db: Queryable,
    key: Pick<FdeStage, 'organisationId' | 'engagementId' | 'stageNumber' | 'attempt'>,
  ): Promise<FdeStage | undefined> {
    return findRow(db, fdeStageTable, key);
  },

  update(db: Queryable, id: FdeStage['id'], changes: FdeStageChanges): Promise<FdeStage | undefined> {
    return updateRow(db, fdeStageTable, { id }, changes);
  },

  async listForEngagement(db: Queryable, engagementId: string): Promise<FdeStage[]> {
    const { rows } = await db.query(
      `select ${fdeStageTable.select} from fde.fde_stages where engagement_id = $1 order by stage_number, attempt`, [engagementId]);
    return rows as FdeStage[];
  },

  /** The latest attempt at a stage. */
  async latest(db: Queryable, engagementId: string, stageNumber: number): Promise<FdeStage | undefined> {
    const { rows } = await db.query(
      `select ${fdeStageTable.select} from fde.fde_stages where engagement_id = $1 and stage_number = $2 order by attempt desc limit 1`,
      [engagementId, stageNumber]);
    return rows[0] as FdeStage | undefined;
  },
};

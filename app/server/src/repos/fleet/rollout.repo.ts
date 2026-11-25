// Data access for fleet.rollouts, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  rolloutTable,
  type NewRollout,
  type Rollout,
  type RolloutChanges,
} from '../../models/fleet/rollout.model.ts';

export const rolloutRepo = {
  insert(db: Queryable, row: NewRollout): Promise<Rollout> {
    return insertRow(db, rolloutTable, row);
  },

  findById(db: Queryable, id: Rollout['id']): Promise<Rollout | undefined> {
    return findRow(db, rolloutTable, { id });
  },

  update(db: Queryable, id: Rollout['id'], changes: RolloutChanges): Promise<Rollout | undefined> {
    return updateRow(db, rolloutTable, { id }, changes);
  },

  /** Every running rollout: at most one per channel, and one per dedicated cell. */
  async listRunning(db: Queryable): Promise<Rollout[]> {
    const { rows } = await db.query(`select ${rolloutTable.select} from fleet.rollouts where status = 'running' order by started_at`);
    return rows as Rollout[];
  },

  /** A dedicated cell's latest own rollout, whatever became of it. */
  async latestForCell(db: Queryable, cellId: string): Promise<Rollout | undefined> {
    const { rows } = await db.query(
      `select ${rolloutTable.select} from fleet.rollouts where cell_id = $1 order by started_at desc, id desc limit 1`, [cellId]);
    return rows[0] as Rollout | undefined;
  },

  /** The release a dedicated cell last took to the end: its latest completed own rollout's. */
  async lastCompletedReleaseForCell(db: Queryable, cellId: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `select release_id as "releaseId" from fleet.rollouts where cell_id = $1 and status = 'completed'
        order by ended_at desc, id desc limit 1`, [cellId]);
    return (rows[0] as { releaseId: string } | undefined)?.releaseId;
  },
};

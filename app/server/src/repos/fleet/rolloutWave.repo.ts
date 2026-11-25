// Data access for fleet.rollout_waves, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  rolloutWaveTable,
  type NewRolloutWave,
  type RolloutWave,
  type RolloutWaveChanges,
  type RolloutWavePrimaryKey,
} from '../../models/fleet/rolloutWave.model.ts';

export const rolloutWaveRepo = {
  insert(db: Queryable, row: NewRolloutWave): Promise<RolloutWave> {
    return insertRow(db, rolloutWaveTable, row);
  },

  findByKey(db: Queryable, key: RolloutWavePrimaryKey): Promise<RolloutWave | undefined> {
    return findRow(db, rolloutWaveTable, key);
  },

  update(
    db: Queryable,
    key: RolloutWavePrimaryKey,
    changes: RolloutWaveChanges,
  ): Promise<RolloutWave | undefined> {
    return updateRow(db, rolloutWaveTable, key, changes);
  },

  /** A rollout's waves, in order. */
  async listByRollout(db: Queryable, rolloutId: RolloutWave['rolloutId']): Promise<RolloutWave[]> {
    const { rows } = await db.query(
      `select ${rolloutWaveTable.select} from fleet.rollout_waves where rollout_id = $1 order by position`, [rolloutId]);
    return rows as RolloutWave[];
  },
};

// Data access for fleet.verdicts, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  verdictTable,
  type NewVerdict,
  type Verdict,
  type VerdictChanges,
  type VerdictPrimaryKey,
} from '../../models/fleet/verdict.model.ts';

export const verdictRepo = {
  insert(db: Queryable, row: NewVerdict): Promise<Verdict> {
    return insertRow(db, verdictTable, row);
  },

  findByKey(db: Queryable, key: VerdictPrimaryKey): Promise<Verdict | undefined> {
    return findRow(db, verdictTable, key);
  },

  update(db: Queryable, key: VerdictPrimaryKey, changes: VerdictChanges): Promise<Verdict | undefined> {
    return updateRow(db, verdictTable, key, changes);
  },

  async listByRollout(db: Queryable, rolloutId: Verdict['rolloutId']): Promise<Verdict[]> {
    const { rows } = await db.query(
      `select ${verdictTable.select} from fleet.verdicts where rollout_id = $1 order by cell_id`, [rolloutId]);
    return rows as Verdict[];
  },

  /** The cell's latest verdict replaces any earlier one for the rollout. */
  async upsert(db: Queryable, row: NewVerdict): Promise<void> {
    await db.query(
      `insert into fleet.verdicts (rollout_id, cell_id, release_id, verdict, failed_gates, reported_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (rollout_id, cell_id) do update
         set release_id = excluded.release_id, verdict = excluded.verdict, failed_gates = excluded.failed_gates,
             reported_at = excluded.reported_at`,
      [row.rolloutId, row.cellId, row.releaseId, row.verdict, row.failedGates ?? [], row.reportedAt]);
  },
};

// Data access for action.blast_radius_results, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  blastRadiusResultTable,
  type BlastRadiusResult,
  type NewBlastRadiusResult,
} from '../../models/action/blastRadiusResult.model.ts';

export const blastRadiusResultRepo = {
  insert(db: Queryable, row: NewBlastRadiusResult): Promise<BlastRadiusResult> {
    return insertRow(db, blastRadiusResultTable, row);
  },

  findById(db: Queryable, id: BlastRadiusResult['id']): Promise<BlastRadiusResult | undefined> {
    return findRow(db, blastRadiusResultTable, { id });
  },

  /** A mutation's recorded radius, nearest first: what its revert re-points (46.6). */
  async listForMutation(db: Queryable, mutationId: string): Promise<BlastRadiusResult[]> {
    const { rows } = await db.query(
      `select ${blastRadiusResultTable.select} from action.blast_radius_results where mutation_id = $1 order by hop, via, dependent_reference`, [mutationId]);
    return rows as BlastRadiusResult[];
  },
};

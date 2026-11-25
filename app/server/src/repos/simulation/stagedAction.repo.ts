// Data access for simulation.staged_actions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  stagedActionTable,
  type NewStagedAction,
  type StagedAction,
  type StagedActionChanges,
} from '../../models/simulation/stagedAction.model.ts';

export const stagedActionRepo = {
  insert(db: Queryable, row: NewStagedAction): Promise<StagedAction> {
    return insertRow(db, stagedActionTable, row);
  },

  findById(db: Queryable, id: StagedAction['id']): Promise<StagedAction | undefined> {
    return findRow(db, stagedActionTable, { id });
  },

  findByBranchIdAndSequence(
    db: Queryable,
    key: Pick<StagedAction, 'organisationId' | 'branchId' | 'sequence'>,
  ): Promise<StagedAction | undefined> {
    return findRow(db, stagedActionTable, key);
  },

  update(
    db: Queryable,
    id: StagedAction['id'],
    changes: StagedActionChanges,
  ): Promise<StagedAction | undefined> {
    return updateRow(db, stagedActionTable, { id }, changes);
  },

  listForBranch(db: Queryable, branchId: string): Promise<StagedAction[]> {
    return db.query(`select ${stagedActionTable.select} from simulation.staged_actions where branch_id = $1 order by sequence`, [branchId])
      .then((r) => r.rows as StagedAction[]);
  },

  async nextSequence(db: Queryable, branchId: string): Promise<number> {
    const { rows } = await db.query('select coalesce(max(sequence), 0) + 1 as n from simulation.staged_actions where branch_id = $1', [branchId]);
    return Number(rows[0].n);
  },
};

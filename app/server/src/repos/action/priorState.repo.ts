// Data access for action.prior_states, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  priorStateTable,
  type NewPriorState,
  type PriorState,
} from '../../models/action/priorState.model.ts';

export const priorStateRepo = {
  insert(db: Queryable, row: NewPriorState): Promise<PriorState> {
    return insertRow(db, priorStateTable, row);
  },

  findById(db: Queryable, id: PriorState['id']): Promise<PriorState | undefined> {
    return findRow(db, priorStateTable, { id });
  },

  findByTargetIdAndBlastRadiusResultIdAndField(
    db: Queryable,
    key: Pick<PriorState, 'organisationId' | 'targetId' | 'blastRadiusResultId' | 'field'>,
  ): Promise<PriorState | undefined> {
    return findRow(db, priorStateTable, key);
  },

  async listByMutation(db: Queryable, mutationId: string): Promise<PriorState[]> {
    const { rows } = await db.query(`select ${priorStateTable.select} from action.prior_states where mutation_id = $1 order by id`, [mutationId]);
    return rows as PriorState[];
  },
};

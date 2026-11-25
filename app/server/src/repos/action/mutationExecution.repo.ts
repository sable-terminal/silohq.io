// Data access for action.mutation_executions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mutationExecutionTable,
  type MutationExecution,
  type MutationExecutionChanges,
  type NewMutationExecution,
} from '../../models/action/mutationExecution.model.ts';

export const mutationExecutionRepo = {
  insert(db: Queryable, row: NewMutationExecution): Promise<MutationExecution> {
    return insertRow(db, mutationExecutionTable, row);
  },

  findById(db: Queryable, id: MutationExecution['id']): Promise<MutationExecution | undefined> {
    return findRow(db, mutationExecutionTable, { id });
  },

  findByMutationIdAndConnectionIdAndPhase(
    db: Queryable,
    key: Pick<MutationExecution, 'organisationId' | 'mutationId' | 'connectionId' | 'phase'>,
  ): Promise<MutationExecution | undefined> {
    return findRow(db, mutationExecutionTable, key);
  },

  update(
    db: Queryable,
    id: MutationExecution['id'],
    changes: MutationExecutionChanges,
  ): Promise<MutationExecution | undefined> {
    return updateRow(db, mutationExecutionTable, { id }, changes);
  },

  async listByMutation(db: Queryable, mutationId: string): Promise<MutationExecution[]> {
    const { rows } = await db.query(
      `select ${mutationExecutionTable.select} from action.mutation_executions where mutation_id = $1 order by created_at, id`, [mutationId]);
    return rows as MutationExecution[];
  },
};

// Data access for action.mutation_verifications, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  mutationVerificationTable,
  type MutationVerification,
  type NewMutationVerification,
} from '../../models/action/mutationVerification.model.ts';

export const mutationVerificationRepo = {
  insert(db: Queryable, row: NewMutationVerification): Promise<MutationVerification> {
    return insertRow(db, mutationVerificationTable, row);
  },

  findById(db: Queryable, id: MutationVerification['id']): Promise<MutationVerification | undefined> {
    return findRow(db, mutationVerificationTable, { id });
  },

  findByExecutionIdAndTargetIdAndField(
    db: Queryable,
    key: Pick<MutationVerification, 'organisationId' | 'executionId' | 'targetId' | 'field'>,
  ): Promise<MutationVerification | undefined> {
    return findRow(db, mutationVerificationTable, key);
  },

  /** Records by their worst field: failed, then diverged, else verified. */
  async outcomesByMutation(db: Queryable, mutationId: string): Promise<{ verified: number; diverged: number; failed: number }> {
    const { rows } = await db.query(
      `select count(*) filter (where failed)::int as failed, count(*) filter (where diverged and not failed)::int as diverged,
              count(*) filter (where not failed and not diverged)::int as verified
         from (select v.target_id, bool_or(v.outcome = 'failed') as failed, bool_or(v.outcome = 'diverged') as diverged
                 from action.mutation_verifications v
                 join action.mutation_executions e on e.organisation_id = v.organisation_id and e.id = v.execution_id
                where e.mutation_id = $1 group by v.target_id) t`, [mutationId]);
    return rows[0] as { verified: number; diverged: number; failed: number };
  },

  async listByMutation(db: Queryable, mutationId: string): Promise<MutationVerification[]> {
    const { rows } = await db.query(
      `select ${mutationVerificationTable.select.split(', ').map((c: string) => `v.${c}`).join(', ')}
         from action.mutation_verifications v
         join action.mutation_executions e on e.organisation_id = v.organisation_id and e.id = v.execution_id
        where e.mutation_id = $1 order by v.id`, [mutationId]);
    return rows as MutationVerification[];
  },
};

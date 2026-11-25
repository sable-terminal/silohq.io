// Data access for action.mutation_targets, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mutationTargetTable,
  type MutationTarget,
  type MutationTargetChanges,
  type NewMutationTarget,
} from '../../models/action/mutationTarget.model.ts';

export const mutationTargetRepo = {
  insert(db: Queryable, row: NewMutationTarget): Promise<MutationTarget> {
    return insertRow(db, mutationTargetTable, row);
  },

  findById(db: Queryable, id: MutationTarget['id']): Promise<MutationTarget | undefined> {
    return findRow(db, mutationTargetTable, { id });
  },

  findByIdempotencyKey(
    db: Queryable,
    key: Pick<MutationTarget, 'organisationId' | 'idempotencyKey'>,
  ): Promise<MutationTarget | undefined> {
    return findRow(db, mutationTargetTable, key);
  },

  update(
    db: Queryable,
    id: MutationTarget['id'],
    changes: MutationTargetChanges,
  ): Promise<MutationTarget | undefined> {
    return updateRow(db, mutationTargetTable, { id }, changes);
  },

  /** In creation order: the plan order. */
  async listByMutation(db: Queryable, mutationId: string): Promise<MutationTarget[]> {
    const { rows } = await db.query(
      `select ${mutationTargetTable.select} from action.mutation_targets where mutation_id = $1 order by created_at, id`, [mutationId]);
    return rows as MutationTarget[];
  },

  /** Fields written through Silo on these objects since a time, by completed mutations: the latest write per object and field. */
  async writesSince(db: Queryable, objectIds: readonly string[], since: string)
    : Promise<{ objectId: string; field: string; mutationId: string; proposerMembershipId: string | null; completedAt: string }[]> {
    const { rows } = await db.query(
      `select distinct on (t.object_id, f.field) t.object_id as "objectId", f.field, m.id as "mutationId",
              coalesce(m.proposer_membership_id, m.authorising_membership_id) as "proposerMembershipId", m.completed_at as "completedAt"
         from action.mutation_targets t
         join action.mutations m on m.organisation_id = t.organisation_id and m.id = t.mutation_id
         cross join lateral unnest(t.fields) as f(field)
        where t.object_id = any($1::uuid[]) and not t.excluded
          and m.status in ('completed', 'completed_with_divergence', 'partially_failed') and m.completed_at > $2
        order by t.object_id, f.field, m.completed_at desc`,
      [objectIds, since]);
    return rows.map((r) => ({ ...r, completedAt: new Date(r.completedAt as string).toISOString() })) as never;
  },
};

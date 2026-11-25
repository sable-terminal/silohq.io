// Data access for action.mutations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mutationTable,
  type Mutation,
  type MutationChanges,
  type NewMutation,
} from '../../models/action/mutation.model.ts';

export const mutationRepo = {
  insert(db: Queryable, row: NewMutation): Promise<Mutation> {
    return insertRow(db, mutationTable, row);
  },

  findById(db: Queryable, id: Mutation['id']): Promise<Mutation | undefined> {
    return findRow(db, mutationTable, { id });
  },

  update(db: Queryable, id: Mutation['id'], changes: MutationChanges): Promise<Mutation | undefined> {
    return updateRow(db, mutationTable, { id }, changes);
  },

  /** Mutation ids, newest first, optionally by status. */
  async list(db: Queryable, status: Mutation['status'] | undefined, limit: number): Promise<string[]> {
    const { rows } = await db.query(
      'select id from action.mutations where ($1::text is null or status = $1) order by created_at desc limit $2', [status ?? null, limit]);
    return rows.map((r: { id: string }) => r.id);
  },

  /** Across organisations: canaries whose chain expired unconfirmed, their sample done (identifiers only). */
  async canariesExpired(db: Queryable, now: string, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from action.canaries_expired($1::timestamptz, $2)', [now, limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** Across organisations: executions started before `before` and never finished (identifiers only). */
  async interrupted(db: Queryable, before: string, limit: number): Promise<{ organisationId: string; mutationId: string; phase: 'canary' | 'full' }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", mutation_id as "mutationId", phase from action.executions_interrupted($1::timestamptz, $2)', [before, limit]);
    return rows as { organisationId: string; mutationId: string; phase: 'canary' | 'full' }[];
  },
};

// Data access for action.action_commits, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  actionCommitTable,
  type ActionCommit,
  type ActionCommitPrimaryKey,
  type NewActionCommit,
} from '../../models/action/actionCommit.model.ts';

export const actionCommitRepo = {
  insert(db: Queryable, row: NewActionCommit): Promise<ActionCommit> {
    return insertRow(db, actionCommitTable, row);
  },

  findByKey(db: Queryable, key: ActionCommitPrimaryKey): Promise<ActionCommit | undefined> {
    return findRow(db, actionCommitTable, key);
  },

  /** The object's log, newest first (action_commits_object_log). */
  async listByObject(db: Queryable, objectId: string, limit: number): Promise<ActionCommit[]> {
    const { rows } = await db.query(
      `select ${actionCommitTable.select} from action.action_commits where object_id = $1 order by committed_at desc, id desc limit $2`, [objectId, limit]);
    return rows as ActionCommit[];
  },

  /** The receipts of every commit on an object, with their mutations, not yet purged (an erasure, spec 70). */
  async receiptsOnObject(db: Queryable, objectId: string, limit: number): Promise<{ mutationId: string; receiptId: string }[]> {
    const { rows } = await db.query(
      `select distinct c.mutation_id as "mutationId", c.receipt_id as "receiptId"
         from action.action_commits c
         join action.receipts r on r.organisation_id = c.organisation_id and r.id = c.receipt_id and r.purged_at is null
        where c.object_id = $1 order by 2 limit $2`, [objectId, limit]);
    return rows as { mutationId: string; receiptId: string }[];
  },

  async listByMutation(db: Queryable, mutationId: string): Promise<ActionCommit[]> {
    const { rows } = await db.query(`select ${actionCommitTable.select} from action.action_commits where mutation_id = $1 order by committed_at, id`, [mutationId]);
    return rows as ActionCommit[];
  },
};

// Data access for workspace.ask_threads, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  askThreadTable,
  type AskThread,
  type AskThreadChanges,
  type NewAskThread,
} from '../../models/workspace/askThread.model.ts';

export const askThreadRepo = {
  insert(db: Queryable, row: NewAskThread): Promise<AskThread> {
    return insertRow(db, askThreadTable, row);
  },

  findById(db: Queryable, id: AskThread['id']): Promise<AskThread | undefined> {
    return findRow(db, askThreadTable, { id });
  },

  update(db: Queryable, id: AskThread['id'], changes: AskThreadChanges): Promise<AskThread | undefined> {
    return updateRow(db, askThreadTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: AskThread['id']): Promise<AskThread | undefined> {
    const { rows } = await db.query(`select ${askThreadTable.select} from workspace.ask_threads where id = $1 for update`, [id]);
    return rows[0] as AskThread | undefined;
  },

  /** A member's own threads, most recently active first; the title filter matches the person's own label. */
  async listOwned(db: Queryable, ownerId: string, filter: { archived: boolean; search?: string | undefined; limit: number }): Promise<AskThread[]> {
    const { rows } = await db.query(
      `select ${askThreadTable.select} from workspace.ask_threads
       where owner_membership_id = $1 and ((archived_at is not null) = $2)
         and ($3::text is null or strpos(lower(title), lower($3)) > 0)
       order by last_activity_at desc, id desc limit $4`,
      [ownerId, filter.archived, filter.search ?? null, filter.limit]);
    return rows as AskThread[];
  },

  /** A transferred view's thread moves with it (spec 37.7). */
  async transferViewThreads(db: Queryable, viewIds: readonly string[], to: string): Promise<number> {
    if (viewIds.length === 0) return 0;
    const { rowCount } = await db.query(
      'update workspace.ask_threads set owner_membership_id = $2 where saved_view_id = any($1::uuid[])', [viewIds, to]);
    return rowCount ?? 0;
  },

  /** A removed member's other threads are archived, not transferred (spec 37.7). */
  async archiveOthersOf(db: Queryable, membershipId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      `update workspace.ask_threads set archived_at = $2
       where owner_membership_id = $1 and saved_view_id is null and archived_at is null`, [membershipId, at]);
    return rowCount ?? 0;
  },
};

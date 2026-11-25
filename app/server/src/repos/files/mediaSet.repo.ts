// Data access for files.media_sets, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mediaSetTable,
  type MediaSet,
  type MediaSetChanges,
  type NewMediaSet,
} from '../../models/files/mediaSet.model.ts';

export const mediaSetRepo = {
  insert(db: Queryable, row: NewMediaSet): Promise<MediaSet> {
    return insertRow(db, mediaSetTable, row);
  },

  findById(db: Queryable, id: MediaSet['id']): Promise<MediaSet | undefined> {
    return findRow(db, mediaSetTable, { id });
  },

  update(db: Queryable, id: MediaSet['id'], changes: MediaSetChanges): Promise<MediaSet | undefined> {
    return updateRow(db, mediaSetTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<MediaSet | undefined> {
    const { rows } = await db.query(`select ${mediaSetTable.select} from files.media_sets where id = $1 for update`, [id]);
    return rows[0] as MediaSet | undefined;
  },

  /** A member's own media sets, newest change first; archived ones only when asked for. */
  async listMine(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<MediaSet[]> {
    const { rows } = await db.query(
      `select ${mediaSetTable.select} from files.media_sets where owner_membership_id = $1 and (archived_at is not null) = $2
       order by updated_at desc limit $3`, [membershipId, archived, limit]);
    return rows as MediaSet[];
  },

  async listByIds(db: Queryable, ids: readonly string[], limit: number): Promise<MediaSet[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${mediaSetTable.select} from files.media_sets where id = any($1::uuid[]) and archived_at is null order by updated_at desc limit $2`, [[...ids], limit]);
    return rows as MediaSet[];
  },
};

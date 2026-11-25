// Data access for files.file_shares, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fileShareTable,
  type FileShare,
  type FileShareChanges,
  type NewFileShare,
} from '../../models/files/fileShare.model.ts';

export const fileShareRepo = {
  insert(db: Queryable, row: NewFileShare): Promise<FileShare> {
    return insertRow(db, fileShareTable, row);
  },

  findById(db: Queryable, id: FileShare['id']): Promise<FileShare | undefined> {
    return findRow(db, fileShareTable, { id });
  },

  update(db: Queryable, id: FileShare['id'], changes: FileShareChanges): Promise<FileShare | undefined> {
    return updateRow(db, fileShareTable, { id }, changes);
  },

  async listForFile(db: Queryable, fileId: string): Promise<FileShare[]> {
    const { rows } = await db.query(`select ${fileShareTable.select} from files.file_shares where file_id = $1 order by created_at desc`, [fileId]);
    return rows as FileShare[];
  },

  /** Revokes every live share of a deleted file; returns how many. */
  async revokeAllFor(db: Queryable, fileId: string, revokedBy: string): Promise<number> {
    const { rowCount } = await db.query(
      'update files.file_shares set revoked_at = now(), revoked_by = $2 where file_id = $1 and revoked_at is null', [fileId, revokedBy]);
    return rowCount ?? 0;
  },
};

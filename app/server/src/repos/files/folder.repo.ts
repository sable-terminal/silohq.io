// Data access for files.folders, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  folderTable,
  type Folder,
  type FolderChanges,
  type NewFolder,
} from '../../models/files/folder.model.ts';

export const folderRepo = {
  insert(db: Queryable, row: NewFolder): Promise<Folder> {
    return insertRow(db, folderTable, row);
  },

  findById(db: Queryable, id: Folder['id']): Promise<Folder | undefined> {
    return findRow(db, folderTable, { id });
  },

  findByParentIdAndName(
    db: Queryable,
    key: Pick<Folder, 'organisationId' | 'parentId' | 'name'>,
  ): Promise<Folder | undefined> {
    return findRow(db, folderTable, key);
  },

  update(db: Queryable, id: Folder['id'], changes: FolderChanges): Promise<Folder | undefined> {
    return updateRow(db, folderTable, { id }, changes);
  },

  /** A folder's children (top level for null), by name. */
  async listChildren(db: Queryable, parentId: string | null): Promise<Folder[]> {
    const { rows } = await db.query(
      `select ${folderTable.select} from files.folders where parent_id is not distinct from $1 order by name limit 1000`, [parentId]);
    return rows as Folder[];
  },
};

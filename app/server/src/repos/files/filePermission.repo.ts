// Data access for files.file_permissions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  filePermissionTable,
  type FilePermission,
  type FilePermissionPrimaryKey,
  type NewFilePermission,
} from '../../models/files/filePermission.model.ts';

export const filePermissionRepo = {
  insert(db: Queryable, row: NewFilePermission): Promise<FilePermission> {
    return insertRow(db, filePermissionTable, row);
  },

  findByKey(db: Queryable, key: FilePermissionPrimaryKey): Promise<FilePermission | undefined> {
    return findRow(db, filePermissionTable, key);
  },
};

// Data access for files.file_deletions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  fileDeletionTable,
  type FileDeletion,
  type NewFileDeletion,
} from '../../models/files/fileDeletion.model.ts';

export const fileDeletionRepo = {
  insert(db: Queryable, row: NewFileDeletion): Promise<FileDeletion> {
    return insertRow(db, fileDeletionTable, row);
  },

  findById(db: Queryable, id: FileDeletion['id']): Promise<FileDeletion | undefined> {
    return findRow(db, fileDeletionTable, { id });
  },

  findByFileId(
    db: Queryable,
    key: Pick<FileDeletion, 'organisationId' | 'fileId'>,
  ): Promise<FileDeletion | undefined> {
    return findRow(db, fileDeletionTable, key);
  },
};

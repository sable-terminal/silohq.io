// Data access for files.file_provenance, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  fileProvenanceTable,
  type FileProvenance,
  type FileProvenancePrimaryKey,
  type NewFileProvenance,
} from '../../models/files/fileProvenance.model.ts';

export const fileProvenanceRepo = {
  insert(db: Queryable, row: NewFileProvenance): Promise<FileProvenance> {
    return insertRow(db, fileProvenanceTable, row);
  },

  findByKey(db: Queryable, key: FileProvenancePrimaryKey): Promise<FileProvenance | undefined> {
    return findRow(db, fileProvenanceTable, key);
  },
};

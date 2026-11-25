// Data access for files.file_markings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  fileMarkingTable,
  type FileMarking,
  type FileMarkingPrimaryKey,
  type NewFileMarking,
} from '../../models/files/fileMarking.model.ts';

export const fileMarkingRepo = {
  insert(db: Queryable, row: NewFileMarking): Promise<FileMarking> {
    return insertRow(db, fileMarkingTable, row);
  },

  findByKey(db: Queryable, key: FileMarkingPrimaryKey): Promise<FileMarking | undefined> {
    return findRow(db, fileMarkingTable, key);
  },

  remove(db: Queryable, key: FileMarkingPrimaryKey): Promise<boolean> {
    return deleteRow(db, fileMarkingTable, key);
  },

  /** The markings a file carries, with their names to show and print. */
  async labelsFor(db: Queryable, fileIds: readonly string[]): Promise<{ fileId: string; id: string; name: string }[]> {
    if (fileIds.length === 0) return [];
    const { rows } = await db.query(
      `select fm.file_id as "fileId", m.id, m.name from files.file_markings fm
       join gov.markings m on m.organisation_id = fm.organisation_id and m.id = fm.marking_id
       where fm.file_id = any($1::uuid[]) order by m.name`, [[...fileIds]]);
    return rows as { fileId: string; id: string; name: string }[];
  },

  /** Names of markings by id (for a preview, before a file exists). */
  async names(db: Queryable, markingIds: readonly string[]): Promise<{ id: string; name: string }[]> {
    if (markingIds.length === 0) return [];
    const { rows } = await db.query('select id, name from gov.markings where id = any($1::uuid[]) order by name', [[...markingIds]]);
    return rows as { id: string; name: string }[];
  },
};

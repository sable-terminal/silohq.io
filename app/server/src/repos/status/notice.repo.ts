// Data access for status.notices, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, status_writer; written by status_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  noticeTable,
  type NewNotice,
  type Notice,
  type NoticeChanges,
} from '../../models/status/notice.model.ts';

export const noticeRepo = {
  insert(db: Queryable, row: NewNotice): Promise<Notice> {
    return insertRow(db, noticeTable, row);
  },

  findById(db: Queryable, id: Notice['id']): Promise<Notice | undefined> {
    return findRow(db, noticeTable, { id });
  },

  update(db: Queryable, id: Notice['id'], changes: NoticeChanges): Promise<Notice | undefined> {
    return updateRow(db, noticeTable, { id }, changes);
  },

  /** Open notices, and closed ones since a time, newest first: what the page shows. */
  async listShown(db: Queryable, closedSince: string): Promise<Notice[]> {
    const { rows } = await db.query(
      `select ${noticeTable.select} from status.notices where resolved_at is null or resolved_at >= $1
       order by resolved_at is not null, started_at desc`, [closedSince]);
    return rows as Notice[];
  },
};

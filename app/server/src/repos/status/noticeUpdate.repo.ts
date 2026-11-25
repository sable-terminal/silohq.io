// Data access for status.notice_updates, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, status_writer; written by status_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  noticeUpdateTable,
  type NewNoticeUpdate,
  type NoticeUpdate,
} from '../../models/status/noticeUpdate.model.ts';

export const noticeUpdateRepo = {
  insert(db: Queryable, row: NewNoticeUpdate): Promise<NoticeUpdate> {
    return insertRow(db, noticeUpdateTable, row);
  },

  findById(db: Queryable, id: NoticeUpdate['id']): Promise<NoticeUpdate | undefined> {
    return findRow(db, noticeUpdateTable, { id });
  },

  /** The updates of these notices, oldest first. */
  async listForNotices(db: Queryable, noticeIds: readonly NoticeUpdate['noticeId'][]): Promise<NoticeUpdate[]> {
    if (noticeIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${noticeUpdateTable.select} from status.notice_updates where notice_id = any($1::uuid[]) order by posted_at, id`,
      [noticeIds]);
    return rows as NoticeUpdate[];
  },
};

// Data access for workspace.reports, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  reportTable,
  type NewReport,
  type Report,
  type ReportChanges,
} from '../../models/workspace/report.model.ts';

export const reportRepo = {
  insert(db: Queryable, row: NewReport): Promise<Report> {
    return insertRow(db, reportTable, row);
  },

  findById(db: Queryable, id: Report['id']): Promise<Report | undefined> {
    return findRow(db, reportTable, { id });
  },

  update(db: Queryable, id: Report['id'], changes: ReportChanges): Promise<Report | undefined> {
    return updateRow(db, reportTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<Report | undefined> {
    const { rows } = await db.query(`select ${reportTable.select} from workspace.reports where id = $1 for update`, [id]);
    return rows[0] as Report | undefined;
  },

  async listMine(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<Report[]> {
    const { rows } = await db.query(
      `select ${reportTable.select} from workspace.reports where owner_membership_id = $1 and (archived_at is not null) = $2
       order by updated_at desc limit $3`, [membershipId, archived, limit]);
    return rows as Report[];
  },

  async listByIds(db: Queryable, ids: readonly string[], limit: number): Promise<Report[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${reportTable.select} from workspace.reports where id = any($1::uuid[]) and archived_at is null order by updated_at desc limit $2`, [[...ids], limit]);
    return rows as Report[];
  },
};

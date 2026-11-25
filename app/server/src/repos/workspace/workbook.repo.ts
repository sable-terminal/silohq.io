// Data access for workspace.workbooks, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  workbookTable,
  type NewWorkbook,
  type Workbook,
  type WorkbookChanges,
} from '../../models/workspace/workbook.model.ts';

export const workbookRepo = {
  insert(db: Queryable, row: NewWorkbook): Promise<Workbook> {
    return insertRow(db, workbookTable, row);
  },

  findById(db: Queryable, id: Workbook['id']): Promise<Workbook | undefined> {
    return findRow(db, workbookTable, { id });
  },

  update(db: Queryable, id: Workbook['id'], changes: WorkbookChanges): Promise<Workbook | undefined> {
    return updateRow(db, workbookTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<Workbook | undefined> {
    const { rows } = await db.query(`select ${workbookTable.select} from workspace.workbooks where id = $1 for update`, [id]);
    return rows[0] as Workbook | undefined;
  },

  /** A member's own workbooks, newest change first; archived ones only when asked for. */
  async listMine(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<Workbook[]> {
    const { rows } = await db.query(
      `select ${workbookTable.select} from workspace.workbooks where owner_membership_id = $1 and (archived_at is not null) = $2
       order by updated_at desc limit $3`, [membershipId, archived, limit]);
    return rows as Workbook[];
  },

  async listByIds(db: Queryable, ids: readonly string[], limit: number): Promise<Workbook[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${workbookTable.select} from workspace.workbooks where id = any($1::uuid[]) and archived_at is null order by updated_at desc limit $2`, [[...ids], limit]);
    return rows as Workbook[];
  },
};

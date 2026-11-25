// Data access for workspace.notebooks, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  notebookTable,
  type NewNotebook,
  type Notebook,
  type NotebookChanges,
} from '../../models/workspace/notebook.model.ts';

export const notebookRepo = {
  insert(db: Queryable, row: NewNotebook): Promise<Notebook> {
    return insertRow(db, notebookTable, row);
  },

  findById(db: Queryable, id: Notebook['id']): Promise<Notebook | undefined> {
    return findRow(db, notebookTable, { id });
  },

  update(db: Queryable, id: Notebook['id'], changes: NotebookChanges): Promise<Notebook | undefined> {
    return updateRow(db, notebookTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<Notebook | undefined> {
    const { rows } = await db.query(`select ${notebookTable.select} from workspace.notebooks where id = $1 for update`, [id]);
    return rows[0] as Notebook | undefined;
  },

  /** A member's own notebooks, newest change first; archived ones only when asked for. */
  async listMine(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<Notebook[]> {
    const { rows } = await db.query(
      `select ${notebookTable.select} from workspace.notebooks where owner_membership_id = $1 and (archived_at is not null) = $2
       order by updated_at desc limit $3`, [membershipId, archived, limit]);
    return rows as Notebook[];
  },

  async listByIds(db: Queryable, ids: readonly string[], limit: number): Promise<Notebook[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${notebookTable.select} from workspace.notebooks where id = any($1::uuid[]) and archived_at is null order by updated_at desc limit $2`, [[...ids], limit]);
    return rows as Notebook[];
  },
};

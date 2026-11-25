// Data access for status.cell_reports, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, status_writer; written by status_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  cellReportTable,
  type CellReport,
  type CellReportChanges,
  type NewCellReport,
} from '../../models/status/cellReport.model.ts';

export const cellReportRepo = {
  insert(db: Queryable, row: NewCellReport): Promise<CellReport> {
    return insertRow(db, cellReportTable, row);
  },

  findByCellId(db: Queryable, cellId: CellReport['cellId']): Promise<CellReport | undefined> {
    return findRow(db, cellReportTable, { cellId });
  },

  update(
    db: Queryable,
    cellId: CellReport['cellId'],
    changes: CellReportChanges,
  ): Promise<CellReport | undefined> {
    return updateRow(db, cellReportTable, { cellId }, changes);
  },

  /** Takes the report, replacing the last one: only the newer report reaches here (the service checks under the lock). */
  async put(db: Queryable, cellId: CellReport['cellId'], reportedAt: CellReport['reportedAt']): Promise<void> {
    await db.query(
      `insert into status.cell_reports (cell_id, reported_at) values ($1, $2)
       on conflict (cell_id) do update set reported_at = excluded.reported_at`, [cellId, reportedAt]);
  },

  async list(db: Queryable): Promise<CellReport[]> {
    const { rows } = await db.query(`select ${cellReportTable.select} from status.cell_reports order by cell_id`);
    return rows as CellReport[];
  },
};

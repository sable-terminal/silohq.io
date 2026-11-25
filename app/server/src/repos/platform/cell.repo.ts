// Data access for platform.cells, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_auth, silo_report; written by silo_app.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, updateRow, type Queryable } from '../base.repo.ts';
import { cellTable, type Cell, type CellChanges } from '../../models/platform/cell.model.ts';

export const cellRepo = {
  findById(db: Queryable, id: Cell['id']): Promise<Cell | undefined> {
    return findRow(db, cellTable, { id });
  },

  findByHostname(db: Queryable, hostname: Cell['hostname']): Promise<Cell | undefined> {
    return findRow(db, cellTable, { hostname });
  },

  update(db: Queryable, id: Cell['id'], changes: CellChanges): Promise<Cell | undefined> {
    return updateRow(db, cellTable, { id }, changes);
  },
};

// Data access for billing.sovereign_terms, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  sovereignTermTable,
  type NewSovereignTerm,
  type SovereignTerm,
  type SovereignTermChanges,
} from '../../models/billing/sovereignTerm.model.ts';

export const sovereignTermRepo = {
  insert(db: Queryable, row: NewSovereignTerm): Promise<SovereignTerm> {
    return insertRow(db, sovereignTermTable, row);
  },

  /** The organisation's terms, newest first. */
  async list(db: Queryable, limit: number): Promise<SovereignTerm[]> {
    const { rows } = await db.query(`select ${sovereignTermTable.select} from billing.sovereign_terms order by entered_at desc, id limit $1`, [limit]);
    return rows as SovereignTerm[];
  },

  findById(db: Queryable, id: SovereignTerm['id']): Promise<SovereignTerm | undefined> {
    return findRow(db, sovereignTermTable, { id });
  },

  update(
    db: Queryable,
    id: SovereignTerm['id'],
    changes: SovereignTermChanges,
  ): Promise<SovereignTerm | undefined> {
    return updateRow(db, sovereignTermTable, { id }, changes);
  },
};

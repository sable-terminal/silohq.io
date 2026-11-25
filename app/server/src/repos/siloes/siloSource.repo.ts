// Data access for siloes.silo_sources, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  siloSourceTable,
  type NewSiloSource,
  type SiloSource,
  type SiloSourceChanges,
} from '../../models/siloes/siloSource.model.ts';

export const siloSourceRepo = {
  insert(db: Queryable, row: NewSiloSource): Promise<SiloSource> {
    return insertRow(db, siloSourceTable, row);
  },

  findById(db: Queryable, id: SiloSource['id']): Promise<SiloSource | undefined> {
    return findRow(db, siloSourceTable, { id });
  },

  update(db: Queryable, id: SiloSource['id'], changes: SiloSourceChanges): Promise<SiloSource | undefined> {
    return updateRow(db, siloSourceTable, { id }, changes);
  },

  async listForSilo(db: Queryable, siloId: string): Promise<SiloSource[]> {
    const { rows } = await db.query(`select ${siloSourceTable.select} from siloes.silo_sources where silo_id = $1 order by created_at, id`, [siloId]);
    return rows as SiloSource[];
  },

  /** Watched locations due a poll, across the cell: identifiers only. */
  async watchedDue(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from siloes.watched_sources_due($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },
};

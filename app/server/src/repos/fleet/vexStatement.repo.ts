// Data access for fleet.vex_statements, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  vexStatementTable,
  type NewVexStatement,
  type VexStatement,
} from '../../models/fleet/vexStatement.model.ts';

export const vexStatementRepo = {
  insert(db: Queryable, row: NewVexStatement): Promise<VexStatement> {
    return insertRow(db, vexStatementTable, row);
  },

  findById(db: Queryable, id: VexStatement['id']): Promise<VexStatement | undefined> {
    return findRow(db, vexStatementTable, { id });
  },

  /** A release's statements, oldest first: the last that applies is the one that holds. */
  async forRelease(db: Queryable, releaseId: string): Promise<VexStatement[]> {
    const { rows } = await db.query(
      `select ${vexStatementTable.select} from fleet.vex_statements where release_id = $1 order by stated_at, id`, [releaseId]);
    return rows as VexStatement[];
  },

  async countForDocument(db: Queryable, releaseId: string, documentDigest: string): Promise<number> {
    const { rows } = await db.query(
      'select count(*)::int as n from fleet.vex_statements where release_id = $1 and document_digest = $2', [releaseId, documentDigest]);
    return (rows[0] as { n: number }).n;
  },
};

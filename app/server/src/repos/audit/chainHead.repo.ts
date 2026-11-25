// Data access for audit.chain_heads, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_audit_writer, silo_report; written by silo_audit_writer.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  chainHeadTable,
  type ChainHead,
  type ChainHeadChanges,
  type NewChainHead,
} from '../../models/audit/chainHead.model.ts';

export const chainHeadRepo = {
  insert(db: Queryable, row: NewChainHead): Promise<ChainHead> {
    return insertRow(db, chainHeadTable, row);
  },

  findById(db: Queryable, id: ChainHead['id']): Promise<ChainHead | undefined> {
    return findRow(db, chainHeadTable, { id });
  },

  findByHeadDate(
    db: Queryable,
    key: Pick<ChainHead, 'organisationId' | 'headDate'>,
  ): Promise<ChainHead | undefined> {
    return findRow(db, chainHeadTable, key);
  },

  update(db: Queryable, id: ChainHead['id'], changes: ChainHeadChanges): Promise<ChainHead | undefined> {
    return updateRow(db, chainHeadTable, { id }, changes);
  },

  /** The organisation's most recent head. */
  async latest(db: Queryable, organisationId: string): Promise<ChainHead | undefined> {
    const { rows } = await db.query(
      `select ${chainHeadTable.select} from audit.chain_heads where organisation_id = $1 order by head_date desc limit 1`, [organisationId]);
    return rows[0] as ChainHead | undefined;
  },

  /** Newest first, before a date if given. */
  async list(db: Queryable, organisationId: string, limit: number, beforeDate?: string): Promise<ChainHead[]> {
    const { rows } = await db.query(
      `select ${chainHeadTable.select} from audit.chain_heads
       where organisation_id = $1 and ($2::date is null or head_date < $2::date) order by head_date desc limit $3`,
      [organisationId, beforeDate ?? null, limit]);
    return rows as ChainHead[];
  },

  /** Every customer organisation of the cell, for the daily close. Identifiers only, through a definer function. */
  async organisationsToClose(db: Queryable): Promise<string[]> {
    const { rows } = await db.query('select id from audit.organisations_for_chain_close() as id');
    return rows.map((row: { id: string }) => row.id);
  },
};

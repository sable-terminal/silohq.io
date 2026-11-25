// Data access for action.ledger_copies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  ledgerCopyTable,
  type LedgerCopy,
  type LedgerCopyChanges,
  type NewLedgerCopy,
} from '../../models/action/ledgerCopy.model.ts';

export const ledgerCopyRepo = {
  insert(db: Queryable, row: NewLedgerCopy): Promise<LedgerCopy> {
    return insertRow(db, ledgerCopyTable, row);
  },

  findById(db: Queryable, id: LedgerCopy['id']): Promise<LedgerCopy | undefined> {
    return findRow(db, ledgerCopyTable, { id });
  },

  update(db: Queryable, id: LedgerCopy['id'], changes: LedgerCopyChanges): Promise<LedgerCopy | undefined> {
    return updateRow(db, ledgerCopyTable, { id }, changes);
  },

  remove(db: Queryable, id: LedgerCopy['id']): Promise<boolean> {
    return deleteRow(db, ledgerCopyTable, { id });
  },

  /** Copies due by now, across the cell (action.ledger_copies_due): identifiers only. */
  async due(db: Queryable, now: string, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from action.ledger_copies_due($1, $2)', [now, limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** One copy, held for this attempt; undefined when another replica holds it or it is gone. */
  async claim(db: Queryable, id: LedgerCopy['id']): Promise<LedgerCopy | undefined> {
    const { rows } = await db.query(`select ${ledgerCopyTable.select} from action.ledger_copies where id = $1 for update skip locked`, [id]);
    return rows[0] as LedgerCopy | undefined;
  },

  /** Copies of these receipts, removed with their values (a receipt purge, 70): how many. */
  async removeForReceipts(db: Queryable, receiptIds: readonly string[]): Promise<number> {
    if (receiptIds.length === 0) return 0;
    const { rowCount } = await db.query('delete from action.ledger_copies where id = any($1::uuid[])', [receiptIds]);
    return rowCount ?? 0;
  },
};

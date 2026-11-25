// Data access for action.receipt_purges, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  receiptPurgeTable,
  type NewReceiptPurge,
  type ReceiptPurge,
  type ReceiptPurgeChanges,
} from '../../models/action/receiptPurge.model.ts';

export const receiptPurgeRepo = {
  insert(db: Queryable, row: NewReceiptPurge): Promise<ReceiptPurge> {
    return insertRow(db, receiptPurgeTable, row);
  },

  findById(db: Queryable, id: ReceiptPurge['id']): Promise<ReceiptPurge | undefined> {
    return findRow(db, receiptPurgeTable, { id });
  },

  update(db: Queryable, id: ReceiptPurge['id'], changes: ReceiptPurgeChanges): Promise<ReceiptPurge | undefined> {
    return updateRow(db, receiptPurgeTable, { id }, changes);
  },

  /** Purges awaiting approval or approved, across the cell (action.receipt_purges_open): identifiers only. */
  async openAcrossCell(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from action.receipt_purges_open($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },
};

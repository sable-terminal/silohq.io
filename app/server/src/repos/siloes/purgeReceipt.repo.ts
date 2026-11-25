// Data access for siloes.purge_receipts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  purgeReceiptTable,
  type NewPurgeReceipt,
  type PurgeReceipt,
} from '../../models/siloes/purgeReceipt.model.ts';

export const purgeReceiptRepo = {
  insert(db: Queryable, row: NewPurgeReceipt): Promise<PurgeReceipt> {
    return insertRow(db, purgeReceiptTable, row);
  },

  findById(db: Queryable, id: PurgeReceipt['id']): Promise<PurgeReceipt | undefined> {
    return findRow(db, purgeReceiptTable, { id });
  },

  findByPurgeRequestId(
    db: Queryable,
    key: Pick<PurgeReceipt, 'organisationId' | 'purgeRequestId'>,
  ): Promise<PurgeReceipt | undefined> {
    return findRow(db, purgeReceiptTable, key);
  },
};

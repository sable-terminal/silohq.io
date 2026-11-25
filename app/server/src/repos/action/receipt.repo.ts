// Data access for action.receipts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import { receiptTable, type NewReceipt, type Receipt } from '../../models/action/receipt.model.ts';

export const receiptRepo = {
  insert(db: Queryable, row: NewReceipt): Promise<Receipt> {
    return insertRow(db, receiptTable, row);
  },

  findById(db: Queryable, id: Receipt['id']): Promise<Receipt | undefined> {
    return findRow(db, receiptTable, { id });
  },

  findByMutationId(
    db: Queryable,
    key: Pick<Receipt, 'organisationId' | 'mutationId'>,
  ): Promise<Receipt | undefined> {
    return findRow(db, receiptTable, key);
  },

  /** Purges one mutation's values (action.purge_mutation_values, as silo_migrate): what it reached. */
  async purgeMutationValues(db: Queryable, mutationId: string)
    : Promise<{ receiptIds: string[]; priorStates: number; verifications: number; conflicts: number; deliveriesFailed: number }> {
    const { rows } = await db.query(
      `select receipt_ids as "receiptIds", prior_states as "priorStates", verifications, conflicts, deliveries_failed as "deliveriesFailed"
         from action.purge_mutation_values($1)`, [mutationId]);
    return rows[0] as { receiptIds: string[]; priorStates: number; verifications: number; conflicts: number; deliveriesFailed: number };
  },

  /** Receipts past their retention, not yet purged, oldest first. */
  async pastRetention(db: Queryable, cutoff: string, limit: number): Promise<{ id: string; mutationId: string }[]> {
    const { rows } = await db.query(
      `select id, mutation_id as "mutationId" from action.receipts
        where purged_at is null and retention_until <= $1 order by retention_until, id limit $2`, [cutoff, limit]);
    return rows as { id: string; mutationId: string }[];
  },

  /** Organisations with receipts past their retention, across the cell. */
  async organisationsPastRetention(db: Queryable, cutoff: string): Promise<string[]> {
    const { rows } = await db.query('select organisation_id as id from action.organisations_with_receipts_due($1::timestamptz)', [cutoff]);
    return rows.map((r: { id: string }) => r.id);
  },
};

// Data access for billing.purchases, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import { purchaseTable, type NewPurchase, type Purchase } from '../../models/billing/purchase.model.ts';

export const purchaseRepo = {
  insert(db: Queryable, row: NewPurchase): Promise<Purchase> {
    return insertRow(db, purchaseTable, row);
  },

  findById(db: Queryable, id: Purchase['id']): Promise<Purchase | undefined> {
    return findRow(db, purchaseTable, { id });
  },

  // Records a purchase once: a retried credit for the same purchase finds the row already
  // there and returns undefined, so the balance is credited exactly once.
  async insertIfAbsent(db: Queryable, row: NewPurchase): Promise<Purchase | undefined> {
    const { rows } = await db.query(
      `insert into billing.purchases (id, organisation_id, kind, quantity, amount, currency, purchased_by,
                                      beneficiary_membership_id, auto_topup, stripe_invoice_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do nothing
       returning ${purchaseTable.select}`,
      [row.id, row.organisationId, row.kind, row.quantity, row.amount, row.currency ?? 'GBP', row.purchasedBy,
        row.beneficiaryMembershipId ?? null, row.autoTopup ?? false, row.stripeInvoiceId ?? null]);
    return rows[0] as Purchase | undefined;
  },

  /** A membership's automatic top-ups since a moment (73.4: bounded per day). */
  async countAutoTopups(db: Queryable, membershipId: string, since: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from billing.purchases where beneficiary_membership_id = $1 and auto_topup and occurred_at >= $2`, [membershipId, since]);
    return (rows[0] as { n: number }).n;
  },

  async listRecent(db: Queryable, organisationId: string, limit: number): Promise<Purchase[]> {
    const { rows } = await db.query(
      `select ${purchaseTable.select} from ${purchaseTable.sql} where organisation_id = $1 order by occurred_at desc limit $2`,
      [organisationId, limit]);
    return rows as Purchase[];
  },
};

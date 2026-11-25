// Data access for billing.invoices, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  invoiceTable,
  type Invoice,
  type InvoiceChanges,
  type NewInvoice,
} from '../../models/billing/invoice.model.ts';

export const invoiceRepo = {
  insert(db: Queryable, row: NewInvoice): Promise<Invoice> {
    return insertRow(db, invoiceTable, row);
  },

  findById(db: Queryable, id: Invoice['id']): Promise<Invoice | undefined> {
    return findRow(db, invoiceTable, { id });
  },

  update(db: Queryable, id: Invoice['id'], changes: InvoiceChanges): Promise<Invoice | undefined> {
    return updateRow(db, invoiceTable, { id }, changes);
  },

  // The mirror of one provider invoice, locked while a webhook applies it.
  async lockByStripeInvoiceId(db: Queryable, stripeInvoiceId: string): Promise<Invoice | undefined> {
    const { rows } = await db.query(
      `select ${invoiceTable.select} from ${invoiceTable.sql} where stripe_invoice_id = $1 for update`, [stripeInvoiceId]);
    return rows[0] as Invoice | undefined;
  },

  async listRecent(db: Queryable, organisationId: string, limit: number): Promise<Invoice[]> {
    const { rows } = await db.query(
      `select ${invoiceTable.select} from ${invoiceTable.sql} where organisation_id = $1 order by created_at desc limit $2`,
      [organisationId, limit]);
    return rows as Invoice[];
  },

  async lockById(db: Queryable, id: string): Promise<Invoice | undefined> {
    const { rows } = await db.query(`select ${invoiceTable.select} from ${invoiceTable.sql} where id = $1 for update`, [id]);
    return rows[0] as Invoice | undefined;
  },

  /** Across organisations: open invoices past their due date (identifiers only). */
  async pastDue(db: Queryable, today: string, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from billing.invoices_past_due($1::date, $2)', [today, limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** How many of the organisation's invoices are overdue. */
  async countOverdue(db: Queryable): Promise<number> {
    const { rows } = await db.query(`select count(*)::int as n from ${invoiceTable.sql} where status = 'overdue'`);
    return (rows[0] as { n: number }).n;
  },
};

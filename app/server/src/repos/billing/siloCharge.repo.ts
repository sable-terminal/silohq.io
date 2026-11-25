// Data access for billing.silo_charges, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  siloChargeTable,
  type NewSiloCharge,
  type SiloCharge,
  type SiloChargeChanges,
} from '../../models/billing/siloCharge.model.ts';

export const siloChargeRepo = {
  insert(db: Queryable, row: NewSiloCharge): Promise<SiloCharge> {
    return insertRow(db, siloChargeTable, row);
  },

  findById(db: Queryable, id: SiloCharge['id']): Promise<SiloCharge | undefined> {
    return findRow(db, siloChargeTable, { id });
  },

  findByPeriodAndSiloIdAndStore(
    db: Queryable,
    key: Pick<SiloCharge, 'organisationId' | 'period' | 'siloId' | 'store'>,
  ): Promise<SiloCharge | undefined> {
    return findRow(db, siloChargeTable, key);
  },

  update(db: Queryable, id: SiloCharge['id'], changes: SiloChargeChanges): Promise<SiloCharge | undefined> {
    return updateRow(db, siloChargeTable, { id }, changes);
  },

  /** A month's lines, by Silo and store. */
  async forPeriod(db: Queryable, period: string): Promise<SiloCharge[]> {
    const { rows } = await db.query(
      `select ${siloChargeTable.select} from billing.silo_charges where period = $1 order by silo_id, store`, [period]);
    return rows as SiloCharge[];
  },

  /** The latest month charged. */
  async latestPeriod(db: Queryable): Promise<string | undefined> {
    const { rows } = await db.query('select max(period) as period from billing.silo_charges', []);
    return (rows[0] as { period: string | null } | undefined)?.period ?? undefined;
  },

  /** Lines invoiced (with the invoice), or not billed. */
  async setState(db: Queryable, ids: readonly string[], state: 'invoiced' | 'not_billed', invoiceId: string | null): Promise<void> {
    if (ids.length === 0) return;
    await db.query(`update billing.silo_charges set invoice_state = $2, invoice_id = $3 where id = any($1::uuid[]) and invoice_state = 'pending'`,
      [ids, state, invoiceId]);
  },

  /** Organisations with a closed month to charge, or charges still to invoice (security definer: every organisation). */
  async due(db: Queryable, period: string, limit: number): Promise<{ organisationId: string; period: string }[]> {
    const { rows } = await db.query('select organisation_id, period from billing.silo_charges_due($1, $2)', [period, limit]);
    return (rows as { organisation_id: string; period: string }[]).map((r) => ({ organisationId: r.organisation_id, period: r.period }));
  },
};

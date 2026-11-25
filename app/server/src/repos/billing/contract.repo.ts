// Data access for billing.contracts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app on a staff path (app.operator_id set),
// and by the sweeps through billing's security definer functions.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  contractTable,
  type Contract,
  type ContractChanges,
  type NewContract,
} from '../../models/billing/contract.model.ts';

export const contractRepo = {
  insert(db: Queryable, row: NewContract): Promise<Contract> {
    return insertRow(db, contractTable, row);
  },

  findById(db: Queryable, id: Contract['id']): Promise<Contract | undefined> {
    return findRow(db, contractTable, { id });
  },

  update(db: Queryable, id: Contract['id'], changes: ContractChanges): Promise<Contract | undefined> {
    return updateRow(db, contractTable, { id }, changes);
  },

  /** Changes the row if it is still at `version`; undefined when someone changed it first. */
  updateAt(db: Queryable, id: string, version: string, changes: ContractChanges): Promise<Contract | undefined> {
    return updateRow(db, contractTable, { id, version }, { ...changes, version: String(BigInt(version) + 1n) });
  },

  async lockById(db: Queryable, id: string): Promise<Contract | undefined> {
    const { rows } = await db.query(`select ${contractTable.select} from ${contractTable.sql} where id = $1 for update`, [id]);
    return rows[0] as Contract | undefined;
  },

  /** The organisation's contracts, newest first. */
  async list(db: Queryable, limit: number): Promise<Contract[]> {
    const { rows } = await db.query(`select ${contractTable.select} from ${contractTable.sql} order by created_at desc, id desc limit $1`, [limit]);
    return rows as Contract[];
  },

  /** Across organisations: active contracts whose renewal state moves today (identifiers only). */
  async toAdvance(db: Queryable, today: string, noticeDays: number, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", id from billing.contracts_to_advance($1::date, $2, $3)', [today, noticeDays, limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** In the organisation's context: 'lapsed', 'upcoming', or null when nothing moved. */
  async advanceRenewal(db: Queryable, id: string, today: string, noticeDays: number): Promise<'lapsed' | 'upcoming' | null> {
    const { rows } = await db.query('select billing.advance_contract_renewal($1, $2::date, $3) as moved', [id, today, noticeDays]);
    return (rows[0] as { moved: 'lapsed' | 'upcoming' | null }).moved;
  },

  /** Across organisations: active contracts after `after`, by id (identifiers only). */
  async active(db: Queryable, limit: number, after: string | null): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from billing.active_contracts($1, $2)', [limit, after]);
    return rows as { organisationId: string; id: string }[];
  },

  /** In the organisation's context: true when `tokens` is more overage than already reported, now recorded. */
  async recordOverage(db: Queryable, id: string, tokens: number): Promise<boolean> {
    const { rows } = await db.query('select billing.record_contract_overage($1, $2) as recorded', [id, tokens]);
    return (rows[0] as { recorded: boolean }).recorded;
  },

  // The organisation's active contract, if any (at most one by the no-overlap exclusion).
  async findActive(db: Queryable, organisationId: string): Promise<Contract | undefined> {
    const { rows } = await db.query(
      `select ${contractTable.select} from ${contractTable.sql}
       where organisation_id = $1 and status = 'active' and term_start <= current_date and term_end >= current_date`, [organisationId]);
    return rows[0] as Contract | undefined;
  },
};

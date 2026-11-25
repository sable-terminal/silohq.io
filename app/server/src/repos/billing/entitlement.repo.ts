// Data access for billing.entitlements, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  entitlementTable,
  type Entitlement,
  type EntitlementChanges,
  type NewEntitlement,
} from '../../models/billing/entitlement.model.ts';

export const entitlementRepo = {
  insert(db: Queryable, row: NewEntitlement): Promise<Entitlement> {
    return insertRow(db, entitlementTable, row);
  },

  findById(db: Queryable, id: Entitlement['id']): Promise<Entitlement | undefined> {
    return findRow(db, entitlementTable, { id });
  },

  update(
    db: Queryable,
    id: Entitlement['id'],
    changes: EntitlementChanges,
  ): Promise<Entitlement | undefined> {
    return updateRow(db, entitlementTable, { id }, changes);
  },

  // The entitlement in force now (spec 71.4): the open row, which every reader reads.
  async findOpen(db: Queryable, organisationId: string): Promise<Entitlement | undefined> {
    const { rows } = await db.query(
      `select ${entitlementTable.select} from ${entitlementTable.sql} where organisation_id = $1 and effective_to is null`,
      [organisationId]);
    return rows[0] as Entitlement | undefined;
  },

  // The entitlement in force at a past moment: rows are never updated in place, so it can be read back.
  async findInForceAt(db: Queryable, organisationId: string, at: string): Promise<Entitlement | undefined> {
    const { rows } = await db.query(
      `select ${entitlementTable.select} from ${entitlementTable.sql}
       where organisation_id = $1 and tstzrange(effective_from, effective_to) @> $2::timestamptz`, [organisationId, at]);
    return rows[0] as Entitlement | undefined;
  },

  // Inserts the successor row, in force from the transaction's own now(): the moment the
  // closed row ended, so the history has no gap and no overlap.
  async insertEffectiveNow(db: Queryable, row: Omit<NewEntitlement, 'effectiveFrom' | 'effectiveTo' | 'createdAt'>): Promise<Entitlement> {
    const { rows } = await db.query(
      `insert into billing.entitlements (id, organisation_id, seats, tokens_per_seat_period, simulations_per_seat_period,
                                         daily_token_limit, storage_included_bytes, capabilities, source, subscription_id,
                                         contract_id, connections_limit, live_objects_limit, sovereign_terms_id, effective_from)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
       returning ${entitlementTable.select}`,
      [row.id, row.organisationId, row.seats, row.tokensPerSeatPeriod, row.simulationsPerSeatPeriod, row.dailyTokenLimit,
        row.storageIncludedBytes, row.capabilities, row.source, row.subscriptionId ?? null, row.contractId ?? null, row.connectionsLimit ?? null,
        row.liveObjectsLimit ?? null, row.sovereignTermsId ?? null]);
    return rows[0] as Entitlement;
  },

  // Closes the open row, the one update the table permits; its successor is inserted in the
  // same transaction. Undefined when no row was open.
  async closeOpen(db: Queryable, organisationId: string): Promise<Entitlement | undefined> {
    const { rows } = await db.query(
      `update billing.entitlements set effective_to = now() where organisation_id = $1 and effective_to is null
       returning ${entitlementTable.select}`, [organisationId]);
    return rows[0] as Entitlement | undefined;
  },
};

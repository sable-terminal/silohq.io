// Data access for action.action_event_deliveries, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  actionEventDeliveryTable,
  type ActionEventDelivery,
  type ActionEventDeliveryChanges,
  type NewActionEventDelivery,
} from '../../models/action/actionEventDelivery.model.ts';

export const actionEventDeliveryRepo = {
  /** Once per subscription and event: a redelivered event adds nothing. Returns whether it was new. */
  async insertOnce(db: Queryable, row: NewActionEventDelivery): Promise<boolean> {
    const { rowCount } = await db.query(
      `insert into action.action_event_deliveries (id, organisation_id, subscription_id, event_id, mutation_id, receipt_id, payload)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (organisation_id, subscription_id, event_id) do nothing`,
      [row.id, row.organisationId, row.subscriptionId, row.eventId, row.mutationId, row.receiptId, JSON.stringify(row.payload)]);
    return (rowCount ?? 0) > 0;
  },

  /** Across organisations: deliveries due to an active subscription (identifiers only). */
  async due(db: Queryable, now: string, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from action.action_event_deliveries_due($1::timestamptz, $2)', [now, limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** A subscription's deliveries still pending: dead-lettered with it. */
  async deadLetterPending(db: Queryable, subscriptionId: string, at: string): Promise<number> {
    const { rowCount } = await db.query(
      `update action.action_event_deliveries set status = 'dead_lettered', dead_lettered_at = $2
       where subscription_id = $1 and status = 'pending'`, [subscriptionId, at]);
    return rowCount ?? 0;
  },

  insert(db: Queryable, row: NewActionEventDelivery): Promise<ActionEventDelivery> {
    return insertRow(db, actionEventDeliveryTable, row);
  },

  findById(db: Queryable, id: ActionEventDelivery['id']): Promise<ActionEventDelivery | undefined> {
    return findRow(db, actionEventDeliveryTable, { id });
  },

  findBySubscriptionIdAndEventId(
    db: Queryable,
    key: Pick<ActionEventDelivery, 'organisationId' | 'subscriptionId' | 'eventId'>,
  ): Promise<ActionEventDelivery | undefined> {
    return findRow(db, actionEventDeliveryTable, key);
  },

  update(
    db: Queryable,
    id: ActionEventDelivery['id'],
    changes: ActionEventDeliveryChanges,
  ): Promise<ActionEventDelivery | undefined> {
    return updateRow(db, actionEventDeliveryTable, { id }, changes);
  },
};

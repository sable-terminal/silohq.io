// Data access for action.action_event_subscriptions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  actionEventSubscriptionTable,
  type ActionEventSubscription,
  type ActionEventSubscriptionChanges,
  type NewActionEventSubscription,
} from '../../models/action/actionEventSubscription.model.ts';

export const actionEventSubscriptionRepo = {
  insert(db: Queryable, row: NewActionEventSubscription): Promise<ActionEventSubscription> {
    return insertRow(db, actionEventSubscriptionTable, row);
  },

  findById(db: Queryable, id: ActionEventSubscription['id']): Promise<ActionEventSubscription | undefined> {
    return findRow(db, actionEventSubscriptionTable, { id });
  },

  findByEndpointUrlAndSecretRef(
    db: Queryable,
    key: Pick<ActionEventSubscription, 'organisationId' | 'endpointUrl' | 'secretRef'>,
  ): Promise<ActionEventSubscription | undefined> {
    return findRow(db, actionEventSubscriptionTable, key);
  },

  update(
    db: Queryable,
    id: ActionEventSubscription['id'],
    changes: ActionEventSubscriptionChanges,
  ): Promise<ActionEventSubscription | undefined> {
    return updateRow(db, actionEventSubscriptionTable, { id }, changes);
  },

  /** The organisation's subscriptions, newest first. */
  async list(db: Queryable, limit: number): Promise<ActionEventSubscription[]> {
    const { rows } = await db.query(
      `select ${actionEventSubscriptionTable.select} from action.action_event_subscriptions order by created_at desc, id desc limit $1`, [limit]);
    return rows as ActionEventSubscription[];
  },

  /** The organisation's active subscriptions: those an event is offered to. */
  async listActive(db: Queryable): Promise<ActionEventSubscription[]> {
    const { rows } = await db.query(
      `select ${actionEventSubscriptionTable.select} from action.action_event_subscriptions where status = 'active' order by id`);
    return rows as ActionEventSubscription[];
  },
};

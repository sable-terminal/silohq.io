// Data access for connect.change_stream_subscriptions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  changeStreamSubscriptionTable,
  type ChangeStreamSubscription,
  type ChangeStreamSubscriptionChanges,
  type NewChangeStreamSubscription,
} from '../../models/connect/changeStreamSubscription.model.ts';

export const changeStreamSubscriptionRepo = {
  insert(db: Queryable, row: NewChangeStreamSubscription): Promise<ChangeStreamSubscription> {
    return insertRow(db, changeStreamSubscriptionTable, row);
  },

  findById(db: Queryable, id: ChangeStreamSubscription['id']): Promise<ChangeStreamSubscription | undefined> {
    return findRow(db, changeStreamSubscriptionTable, { id });
  },

  update(
    db: Queryable,
    id: ChangeStreamSubscription['id'],
    changes: ChangeStreamSubscriptionChanges,
  ): Promise<ChangeStreamSubscription | undefined> {
    return updateRow(db, changeStreamSubscriptionTable, { id }, changes);
  },
};

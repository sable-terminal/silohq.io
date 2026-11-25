// Data access for connect.stream_polling_fallbacks, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  streamPollingFallbackTable,
  type NewStreamPollingFallback,
  type StreamPollingFallback,
  type StreamPollingFallbackChanges,
} from '../../models/connect/streamPollingFallback.model.ts';

export const streamPollingFallbackRepo = {
  insert(db: Queryable, row: NewStreamPollingFallback): Promise<StreamPollingFallback> {
    return insertRow(db, streamPollingFallbackTable, row);
  },

  findById(db: Queryable, id: StreamPollingFallback['id']): Promise<StreamPollingFallback | undefined> {
    return findRow(db, streamPollingFallbackTable, { id });
  },

  update(
    db: Queryable,
    id: StreamPollingFallback['id'],
    changes: StreamPollingFallbackChanges,
  ): Promise<StreamPollingFallback | undefined> {
    return updateRow(db, streamPollingFallbackTable, { id }, changes);
  },

  /** The connection's fallbacks in force, by object. */
  async activeFor(db: Queryable, connectionId: string): Promise<StreamPollingFallback[]> {
    const { rows } = await db.query(
      `select ${streamPollingFallbackTable.select} from connect.stream_polling_fallbacks
       where connection_id = $1 and disabled_at is null order by object`, [connectionId]);
    return rows as StreamPollingFallback[];
  },
};

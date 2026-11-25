// Data access for connect.writable_points, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  writablePointTable,
  type NewWritablePoint,
  type WritablePoint,
  type WritablePointChanges,
} from '../../models/connect/writablePoint.model.ts';

export const writablePointRepo = {
  insert(db: Queryable, row: NewWritablePoint): Promise<WritablePoint> {
    return insertRow(db, writablePointTable, row);
  },

  findById(db: Queryable, id: WritablePoint['id']): Promise<WritablePoint | undefined> {
    return findRow(db, writablePointTable, { id });
  },

  findByConnectionIdAndManifestIdAndAddress(
    db: Queryable,
    key: Pick<WritablePoint, 'organisationId' | 'connectionId' | 'manifestId' | 'address'>,
  ): Promise<WritablePoint | undefined> {
    return findRow(db, writablePointTable, key);
  },

  update(
    db: Queryable,
    id: WritablePoint['id'],
    changes: WritablePointChanges,
  ): Promise<WritablePoint | undefined> {
    return updateRow(db, writablePointTable, { id }, changes);
  },

  /** A connection's points, live ones only unless asked, oldest first. */
  async listForConnection(db: Queryable, connectionId: string, includeRetired: boolean): Promise<WritablePoint[]> {
    const { rows } = await db.query(
      `select ${writablePointTable.select} from connect.writable_points where connection_id = $1 and ($2 or retired_at is null) order by declared_at`,
      [connectionId, includeRetired]);
    return rows as WritablePoint[];
  },
};

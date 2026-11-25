// Data access for clone.staleness_thresholds, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  stalenessThresholdTable,
  type NewStalenessThreshold,
  type StalenessThreshold,
  type StalenessThresholdChanges,
} from '../../models/clone/stalenessThreshold.model.ts';

export const stalenessThresholdRepo = {
  insert(db: Queryable, row: NewStalenessThreshold): Promise<StalenessThreshold> {
    return insertRow(db, stalenessThresholdTable, row);
  },

  findById(db: Queryable, id: StalenessThreshold['id']): Promise<StalenessThreshold | undefined> {
    return findRow(db, stalenessThresholdTable, { id });
  },

  update(
    db: Queryable,
    id: StalenessThreshold['id'],
    changes: StalenessThresholdChanges,
  ): Promise<StalenessThreshold | undefined> {
    return updateRow(db, stalenessThresholdTable, { id }, changes);
  },

  /** The one threshold for a connection, all types (null) or one type, locked for change. */
  async findForUpdate(db: Queryable, connectionId: string, objectTypeId: string | null): Promise<StalenessThreshold | undefined> {
    const { rows } = await db.query(
      `select ${stalenessThresholdTable.select} from clone.staleness_thresholds
       where connection_id = $1 and object_type_id is not distinct from $2 for update`, [connectionId, objectTypeId]);
    return rows[0] as StalenessThreshold | undefined;
  },

  async list(db: Queryable, connectionId: string | undefined): Promise<StalenessThreshold[]> {
    const { rows } = await db.query(
      `select ${stalenessThresholdTable.select} from clone.staleness_thresholds
       where ($1::uuid is null or connection_id = $1) order by connection_id, object_type_id nulls first`, [connectionId ?? null]);
    return rows as StalenessThreshold[];
  },
};

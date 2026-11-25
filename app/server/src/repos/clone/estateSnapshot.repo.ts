// Data access for clone.estate_snapshots, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  estateSnapshotTable,
  type EstateSnapshot,
  type NewEstateSnapshot,
} from '../../models/clone/estateSnapshot.model.ts';

export const estateSnapshotRepo = {
  insert(db: Queryable, row: NewEstateSnapshot): Promise<EstateSnapshot> {
    return insertRow(db, estateSnapshotTable, row);
  },

  findById(db: Queryable, id: EstateSnapshot['id']): Promise<EstateSnapshot | undefined> {
    return findRow(db, estateSnapshotTable, { id });
  },

  async listRecent(db: Queryable, limit: number): Promise<EstateSnapshot[]> {
    const { rows } = await db.query(
      `select ${estateSnapshotTable.select} from clone.estate_snapshots order by taken_at desc, id limit $1`, [limit]);
    return rows as EstateSnapshot[];
  },
};

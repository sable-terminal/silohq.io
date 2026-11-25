// Data access for recognition.detector_thresholds, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  detectorThresholdTable,
  type DetectorThreshold,
  type DetectorThresholdChanges,
  type NewDetectorThreshold,
} from '../../models/recognition/detectorThreshold.model.ts';

export const detectorThresholdRepo = {
  insert(db: Queryable, row: NewDetectorThreshold): Promise<DetectorThreshold> {
    return insertRow(db, detectorThresholdTable, row);
  },

  findById(db: Queryable, id: DetectorThreshold['id']): Promise<DetectorThreshold | undefined> {
    return findRow(db, detectorThresholdTable, { id });
  },

  findByDetectorIdAndObjectTypeIdAndProperty(
    db: Queryable,
    key: Pick<DetectorThreshold, 'organisationId' | 'detectorId' | 'objectTypeId' | 'property'>,
  ): Promise<DetectorThreshold | undefined> {
    return findRow(db, detectorThresholdTable, key);
  },

  update(
    db: Queryable,
    id: DetectorThreshold['id'],
    changes: DetectorThresholdChanges,
  ): Promise<DetectorThreshold | undefined> {
    return updateRow(db, detectorThresholdTable, { id }, changes);
  },

  /** Optimistic: undefined when another tuning moved it first. */
  async tuneAtVersion(db: Queryable, id: string, version: number, value: string): Promise<DetectorThreshold | undefined> {
    const { rows } = await db.query(
      `update recognition.detector_thresholds set value = $3, origin = 'tuned', tuned = true, version = version + 1
        where id = $1 and version = $2 returning ${detectorThresholdTable.select}`, [id, version, value]);
    return rows[0] as DetectorThreshold | undefined;
  },
};

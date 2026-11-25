// Data access for recognition.detectors, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by no service.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import { detectorTable, type Detector } from '../../models/recognition/detector.model.ts';

export const detectorRepo = {
  findById(db: Queryable, id: Detector['id']): Promise<Detector | undefined> {
    return findRow(db, detectorTable, { id });
  },

  findByKey(db: Queryable, key: Detector['key']): Promise<Detector | undefined> {
    return findRow(db, detectorTable, { key });
  },

  findByName(db: Queryable, name: Detector['name']): Promise<Detector | undefined> {
    return findRow(db, detectorTable, { name });
  },

  /** The active registry, by key. */
  async listActive(db: Queryable): Promise<Detector[]> {
    const { rows } = await db.query(`select ${detectorTable.select} from recognition.detectors where status = 'active' order by key`);
    return rows as Detector[];
  },
};

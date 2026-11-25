// Data access for recognition.detector_runs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  detectorRunTable,
  type DetectorRun,
  type DetectorRunChanges,
  type NewDetectorRun,
} from '../../models/recognition/detectorRun.model.ts';

export const detectorRunRepo = {
  insert(db: Queryable, row: NewDetectorRun): Promise<DetectorRun> {
    return insertRow(db, detectorRunTable, row);
  },

  findById(db: Queryable, id: DetectorRun['id']): Promise<DetectorRun | undefined> {
    return findRow(db, detectorRunTable, { id });
  },

  update(
    db: Queryable,
    id: DetectorRun['id'],
    changes: DetectorRunChanges,
  ): Promise<DetectorRun | undefined> {
    return updateRow(db, detectorRunTable, { id }, changes);
  },

  /** Each detector's latest run on a type. */
  async latestPerDetector(db: Queryable, objectTypeId: string): Promise<DetectorRun[]> {
    const { rows } = await db.query(
      `select distinct on (detector_id) ${detectorRunTable.select} from recognition.detector_runs
        where object_type_id = $1 order by detector_id, started_at desc`, [objectTypeId]);
    return rows as DetectorRun[];
  },

  /** Per type, the largest population among each detector's latest run that ran: the sample association analysis states. */
  async latestRanPopulations(db: Queryable): Promise<{ objectTypeId: string; population: string }[]> {
    const { rows } = await db.query(
      `select object_type_id as "objectTypeId", max(population_count)::text as population
         from (select distinct on (object_type_id, detector_id) object_type_id, state, population_count
                 from recognition.detector_runs order by object_type_id, detector_id, started_at desc) latest
        where state = 'ran' group by 1`);
    return rows as { objectTypeId: string; population: string }[];
  },

  async listByIds(db: Queryable, ids: readonly string[]): Promise<DetectorRun[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(`select ${detectorRunTable.select} from recognition.detector_runs where id = any($1::uuid[])`, [ids]);
    return rows as DetectorRun[];
  },
};

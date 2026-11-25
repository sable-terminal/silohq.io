// Data access for fde.fde_metrics, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import { fdeMetricTable, type FdeMetric, type NewFdeMetric } from '../../models/fde/fdeMetric.model.ts';

export const fdeMetricRepo = {
  insert(db: Queryable, row: NewFdeMetric): Promise<FdeMetric> {
    return insertRow(db, fdeMetricTable, row);
  },

  findById(db: Queryable, id: FdeMetric['id']): Promise<FdeMetric | undefined> {
    return findRow(db, fdeMetricTable, { id });
  },

  /** The latest row per metric and cut. */
  async latestFor(db: Queryable, engagementId: string): Promise<FdeMetric[]> {
    const { rows } = await db.query(
      `select distinct on (metric, dimensions) ${fdeMetricTable.select} from fde.fde_metrics where engagement_id = $1
       order by metric, dimensions, measured_at desc, id desc`, [engagementId]);
    return rows as FdeMetric[];
  },
};

// Data access for fleet.release_sboms, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  releaseSbomTable,
  type NewReleaseSbom,
  type ReleaseSbom,
  type ReleaseSbomPrimaryKey,
} from '../../models/fleet/releaseSbom.model.ts';

export const releaseSbomRepo = {
  insert(db: Queryable, row: NewReleaseSbom): Promise<ReleaseSbom> {
    return insertRow(db, releaseSbomTable, row);
  },

  findByKey(db: Queryable, key: ReleaseSbomPrimaryKey): Promise<ReleaseSbom | undefined> {
    return findRow(db, releaseSbomTable, key);
  },

  /** The SBOMs received for a release, in the order they came. */
  async forRelease(db: Queryable, releaseId: string): Promise<ReleaseSbom[]> {
    const { rows } = await db.query(
      `select ${releaseSbomTable.select} from fleet.release_sboms where release_id = $1 order by received_at, digest`, [releaseId]);
    return rows as ReleaseSbom[];
  },
};

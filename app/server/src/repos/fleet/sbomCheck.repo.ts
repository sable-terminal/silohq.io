// Data access for fleet.sbom_checks, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  sbomCheckTable,
  type NewSbomCheck,
  type SbomCheck,
  type SbomCheckChanges,
} from '../../models/fleet/sbomCheck.model.ts';

export const sbomCheckRepo = {
  insert(db: Queryable, row: NewSbomCheck): Promise<SbomCheck> {
    return insertRow(db, sbomCheckTable, row);
  },

  findByReleaseId(db: Queryable, releaseId: SbomCheck['releaseId']): Promise<SbomCheck | undefined> {
    return findRow(db, sbomCheckTable, { releaseId });
  },

  update(
    db: Queryable,
    releaseId: SbomCheck['releaseId'],
    changes: SbomCheckChanges,
  ): Promise<SbomCheck | undefined> {
    return updateRow(db, sbomCheckTable, { releaseId }, changes);
  },

  /** The release's latest check, replacing the one before. */
  async record(db: Queryable, row: { releaseId: string; checkedAt: string; components: number; unmatched: number; findings: number; blocking: number }): Promise<void> {
    await db.query(
      `insert into fleet.sbom_checks (release_id, checked_at, components, unmatched, findings, blocking) values ($1, $2, $3, $4, $5, $6)
       on conflict (release_id) do update set checked_at = excluded.checked_at, components = excluded.components,
         unmatched = excluded.unmatched, findings = excluded.findings, blocking = excluded.blocking`,
      [row.releaseId, row.checkedAt, row.components, row.unmatched, row.findings, row.blocking]);
  },
};
